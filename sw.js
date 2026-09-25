/*
 * PeerKit's service worker. It does three things:
 *   - makes the app installable (Android: "Add to home screen", desktop: the install button);
 *   - keeps the app opening with no network, by serving the last copy of its files when a fetch fails;
 *   - receives Android shares ("Share → PeerKit"), which arrive as a POST that no static host can answer.
 * It is a classic worker, not a module, because Firefox still has no module workers.
 * VERSION must match APP_VERSION in app/version.js and SHELL must list the app's files; test/pwa-test.mjs checks both.
 */
const VERSION = '0.13.2';
const CACHE = `peerkit-${VERSION}`;
const SHARE_CACHE = 'peerkit-share'; // read and emptied by app/share.js; the names below are shared with it
const SHARE_INDEX = 'share-index';
const SHARE_FILE = 'share-file-'; // + its position in the share
const MAX_SHARE_BYTES = 2 * 1024 * 1024 * 1024; // one share; bigger than this is a job for the file picker

// Everything the app needs to start, the chat's vendor/yjs.js included. vendor/editor.js (0.7 MB) is left out: it
// is loaded when the Editor tab is first opened (or a text file in the viewer) and cached then, so an offline device
// that never opened the editor doesn't pay for it. vendor/dockview.js and .css (0.5 MB) likewise: only a wide screen
// with a mouse loads them, never a phone. vendor/pdf.js and pdf.worker.js (1.7 MB): only a PDF opened on a browser
// without a PDF viewer of its own (Android Chrome).
const SHELL = [
	'./',
	'manifest.webmanifest',
	'icon.svg',
	'icon-192.png',
	'icon-512.png',
	'icon-maskable-512.png',
	'apple-touch-icon.png',
	'favicon.ico',
	'app/main.js',
	'app/crypto.js',
	'app/device.js',
	'app/docsync.js',
	'app/emitter.js',
	'app/protocol.js',
	'app/pwa.js',
	'app/room.js',
	'app/roomdoc.js',
	'app/rooms.js',
	'app/settings.js',
	'app/share.js',
	'app/turn.js',
	'app/util.js',
	'app/voice.js',
	'app/version.js',
	'app/tools/stream.js',
	'app/tools/chat/chat.js',
	'app/tools/chat/kept.js',
	'app/tools/chat/timeline.js',
	'app/tools/chat/transfers.js',
	'app/tools/chat/viewer.js',
	'app/tools/editor/editor.js',
	'app/tools/whiteboard/boards.js',
	'app/tools/whiteboard/canvas.js',
	'app/tools/whiteboard/images.js',
	'app/tools/whiteboard/ink.js',
	'app/tools/whiteboard/whiteboard.js',
	'app/ui/code.js',
	'app/ui/dom.js',
	'app/ui/layout.js',
	'app/ui/qr.js',
	'app/ui/settings-view.js',
	'app/ui/start-view.js',
	'app/ui/styles.css',
	'vendor/peerjs.min.js',
	'vendor/qrcode.js',
	'vendor/words.js',
	'vendor/yjs.js',
];

const scope = () => self.registration.scope;
const inScope = name => new URL(name, scope()).href;

self.addEventListener('install', event => {
	// One missing file must not fail the whole install: the app still works, it just isn't complete offline.
	event.waitUntil(caches.open(CACHE).then(cache => Promise.all(SHELL.map(name => cache.add(name).catch(() => {})))));
	self.skipWaiting();
});

self.addEventListener('activate', event => {
	event.waitUntil((async () => {
		for (const name of await caches.keys()) {
			if (name.startsWith('peerkit-') && name !== CACHE && name !== SHARE_CACHE) await caches.delete(name);
		}
		await self.clients.claim();
	})());
});

self.addEventListener('fetch', event => {
	const { request } = event;
	const url = new URL(request.url);
	if (request.method === 'POST' && url.href === inScope('share-target')) {
		event.respondWith(receiveShare(request));
		return;
	}
	// Everything else: only this site's own GETs, and never a range request (a partial response can't be cached).
	if (request.method !== 'GET' || url.origin !== self.location.origin || request.headers.has('range')) return;
	event.respondWith(networkFirst(request));
});

/** The network decides what is current; the cache is the fallback when it can't be reached. */
async function networkFirst(request) {
	try {
		const response = await fetch(request);
		if (response.status === 200) { // same-origin only, so there are no opaque responses to keep out
			const copy = response.clone();
			caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
		}
		return response;
	} catch (err) {
		const cached = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
		if (cached) return cached;
		if (request.mode === 'navigate') {
			const shell = await caches.match(inScope('./'));
			if (shell) return shell;
		}
		throw err;
	}
}

/**
 * "Share → PeerKit" from another Android app. The POST can't be answered by a page, so it is kept here and
 * the browser is sent to the app, which picks it up (app/share.js) and offers it to the Chat.
 */
async function receiveShare(request) {
	try {
		const form = await request.formData();
		const cache = await caches.open(SHARE_CACHE);
		for (const key of await cache.keys()) await cache.delete(key); // only the newest share is kept
		const index = {
			at: Date.now(),
			title: text(form.get('title')),
			text: text(form.get('text')),
			url: text(form.get('url')),
			files: [],
		};
		let total = 0;
		let position = 0;
		for (const file of form.getAll('files')) {
			if (typeof file === 'string' || !file) continue;
			total += file.size;
			if (total > MAX_SHARE_BYTES) break; // what doesn't fit is left out; the app shows what did
			const key = SHARE_FILE + position++;
			await cache.put(inScope(key), new Response(file, { headers: { 'content-type': file.type || 'application/octet-stream' } }));
			index.files.push({ key, name: text(file.name) || 'file', size: file.size, type: text(file.type) });
		}
		await cache.put(inScope(SHARE_INDEX), new Response(JSON.stringify(index), { headers: { 'content-type': 'application/json' } }));
	} catch {
		// Out of storage, or a share this browser sends in a way we don't understand: open the app anyway.
	}
	return Response.redirect(inScope('./?share=1'), 303);
}

const text = value => (typeof value === 'string' ? value.slice(0, 4096) : '');
