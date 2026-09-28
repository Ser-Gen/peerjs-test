// The installable app: manifest.webmanifest, sw.js and app/share.js — the Android share target end to end.
// The service worker runs for real (test/sw-harness.mjs); app/share.js then reads what it wrote.
import { readFileSync, readdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { diskFetch, fakeCaches, loadServiceWorker } from './sw-harness.mjs';

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, ''); // the repo root
const SCOPE = 'https://peerkit.test/';

let failures = 0;
function check(name, ok, extra = '') {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
	if (!ok) failures++;
}

const read = name => readFileSync(`${ROOT}/${name}`, 'utf8');
const pngSize = name => {
	const bytes = readFileSync(`${ROOT}/${name}`);
	return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};
// The alpha of an RGBA PNG's top-left pixel (null for another colour type). The first pixel of the first row is stored
// as it is whatever the row's filter, so it is byte 4 of the inflated data (after the filter byte).
const pngCornerAlpha = name => {
	const bytes = readFileSync(`${ROOT}/${name}`);
	if (bytes[25] !== 6 || bytes[24] !== 8) return null;
	const data = [];
	for (let at = 8; at < bytes.length;) {
		const length = bytes.readUInt32BE(at);
		if (bytes.toString('latin1', at + 4, at + 8) === 'IDAT') data.push(bytes.subarray(at + 8, at + 8 + length));
		at += 12 + length;
	}
	return inflateSync(Buffer.concat(data))[4];
};
// Each entry of an .ico: its size, bits per pixel and the alpha of its top-left pixel (32-bit BMP entries only:
// rows go bottom up, so the top row is the last one before the AND mask).
const icoEntries = name => {
	const bytes = readFileSync(`${ROOT}/${name}`);
	return Array.from({ length: bytes.readUInt16LE(4) }, (_, i) => {
		const entry = 6 + 16 * i;
		const size = bytes[entry] || 256;
		const bpp = bytes.readUInt16LE(entry + 6);
		const offset = bytes.readUInt32LE(entry + 12);
		const top = offset + bytes.readUInt32LE(offset) + (size - 1) * size * 4;
		return { size, bpp, cornerAlpha: bpp === 32 ? bytes[top + 3] : null };
	});
};

// --- the manifest ---

const manifest = JSON.parse(read('manifest.webmanifest'));
check('index.html links the manifest', read('index.html').includes('<link rel="manifest" href="manifest.webmanifest">'));
check('the manifest names the app and opens it standalone',
	manifest.name === 'PeerKit' && manifest.short_name === 'PeerKit' && manifest.display === 'standalone');
check('start_url and scope are relative, so a subdirectory works', manifest.start_url === './' && manifest.scope === './');

const icons = Object.fromEntries(manifest.icons.map(i => [i.src, i]));
check('it offers the 192 and 512 icons Chrome asks for',
	pngSize('icon-192.png').join() === '192,192' && pngSize('icon-512.png').join() === '512,512'
	&& icons['icon-192.png']?.sizes === '192x192' && icons['icon-512.png']?.sizes === '512x512');
check('and a maskable one, so Android does not put the icon in a white box',
	icons['icon-maskable-512.png']?.purpose === 'maskable' && pngSize('icon-maskable-512.png').join() === '512,512');
check('the rounded icons have transparent corners (QuickLook renders onto white, so a render left as it is has white ones)',
	pngCornerAlpha('icon-192.png') === 0 && pngCornerAlpha('icon-512.png') === 0,
	`${pngCornerAlpha('icon-192.png')}, ${pngCornerAlpha('icon-512.png')}`);
const ico = icoEntries('favicon.ico');
check('favicon.ico holds 16, 32 and 48 px, each 32-bit with see-through corners (a palette entry loses its alpha)',
	ico.map(e => e.size).join() === '16,32,48' && ico.every(e => e.bpp === 32 && e.cornerAlpha < 16),
	JSON.stringify(ico));

const target = manifest.share_target;
check('the share target takes files by POST',
	target.action === 'share-target' && target.method === 'POST' && target.enctype === 'multipart/form-data'
	&& target.params.files[0].name === 'files' && target.params.files[0].accept.includes('*/*'),
	JSON.stringify(target));
check('and the title, text and URL of a shared link',
	target.params.title === 'title' && target.params.text === 'text' && target.params.url === 'url');

// --- the shell the worker caches ---

const sw = read('sw.js');
const { APP_VERSION } = await import(`${ROOT}/app/version.js`);
check('sw.js caches under the app version, so an update starts a new cache',
	sw.includes(`const VERSION = '${APP_VERSION}';`), `APP_VERSION ${APP_VERSION}`);

const walk = dir => readdirSync(`${ROOT}/${dir}`, { withFileTypes: true }).flatMap(entry =>
	entry.isDirectory() ? walk(`${dir}/${entry.name}`) : entry.name.endsWith('.js') ? [`${dir}/${entry.name}`] : []);
const shell = sw.match(/const SHELL = \[([\s\S]*?)\];/)[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
// The exceptions are cached on first use: vendor/editor.js (0.7 MB) when the Editor tab is first opened,
// vendor/dockview.js (0.4 MB) only on a wide screen with a mouse, which a phone never has, pdf.js (1.7 MB) only
// for a PDF on a browser without a PDF viewer of its own, and Monaco (3.8 MB) only when a document opens in it.
const LAZY = ['editor.js', 'dockview.js', 'pdf.js', 'pdf.worker.js', 'monaco.js', 'monaco.worker.js'];
const vendor = readdirSync(`${ROOT}/vendor`).filter(name => name.endsWith('.js') && !LAZY.includes(name)).map(name => `vendor/${name}`);
const wanted = [...walk('app'), ...vendor, 'app/ui/styles.css', './'];
const missing = wanted.filter(file => !shell.includes(file));
check('the shell lists every app file, so a new one is not forgotten', missing.length === 0, missing.join(', '));

// --- install and update ---

const network = { online: true };
const disk = diskFetch(ROOT, SCOPE);
const fetch = async input => {
	if (!network.online) throw new TypeError('Failed to fetch');
	return disk(input);
};
const { api: caches, store } = fakeCaches(SCOPE, fetch);
await caches.open('peerkit-0.0.1'); // a cache from an older version
await caches.open('peerkit-share');
const worker = loadServiceWorker(`${ROOT}/sw.js`, { scope: SCOPE, caches, fetch });
await worker.install();
await worker.activate();

const cache = await caches.open(`peerkit-${APP_VERSION}`);
const cached = (await cache.keys()).map(request => request.url);
const notCached = shell.filter(name => !cached.includes(new URL(name, SCOPE).href));
check('installing caches the whole shell from disk', notCached.length === 0, notCached.join(', '));
check('the start page is in it', Boolean(await cache.match(SCOPE)));
check('activating drops the cache of the older version but keeps the share',
	!store.has('peerkit-0.0.1') && store.has('peerkit-share'), [...store.keys()].join(', '));

// --- serving pages ---

const get = (path, init = {}) => worker.request(new Request(new URL(path, SCOPE), init));
// A navigation: the mode can't be passed to the constructor, so it is put on the request the way the browser has it.
const navigate = path => {
	const request = new Request(new URL(path, SCOPE));
	Object.defineProperty(request, 'mode', { value: 'navigate' });
	return worker.request(request);
};
const style = await get('app/ui/styles.css');
check('a file comes from the network while there is one', style.status === 200 && (await style.text()).includes('--accent'));
network.online = false;
const offline = await get('app/ui/styles.css');
check('and from the cache when there is none', offline.status === 200 && (await offline.text()).includes('--accent'));
const page = await navigate('?share=1');
check('an address that was never opened still gets the app offline', page.status === 200 && (await page.text()).includes('PeerKit needs JavaScript'));
network.online = true;
check('other origins are left alone', (await worker.request(new Request('https://0.peerjs.com/peerjs/id'))) === null);
check('so are POSTs that are not a share', (await get('anything', { method: 'POST' })) === null);

// --- the share target ---

globalThis.caches = caches;
globalThis.location = { href: SCOPE };
const { dropShare, peekShare, takeShare } = await import(`${ROOT}/app/share.js`);

const shared = new FormData();
shared.append('title', 'Holiday');
shared.append('text', 'Holiday');
shared.append('url', 'https://example.com/a');
shared.append('files', new File(['first bytes'], 'photo.jpg', { type: 'image/jpeg' }));
shared.append('files', new File(['second'], 'clip.mp4', { type: 'video/mp4' }));
const answer = await worker.request(new Request(`${SCOPE}share-target`, { method: 'POST', body: shared }));
check('a share redirects to the app instead of trying to POST to a static host',
	answer.status === 303 && answer.headers.get('location') === `${SCOPE}?share=1`,
	`${answer.status} ${answer.headers.get('location')}`);

const waiting = await peekShare();
check('the app sees what is waiting without reading the files',
	waiting.files.length === 2 && waiting.files[0].name === 'photo.jpg' && waiting.files[1].size === 6, JSON.stringify(waiting.files));
check('a title, text and URL that repeat each other become one text', waiting.text === 'Holiday\nhttps://example.com/a', waiting.text);

const taken = await takeShare();
check('taking it gives the files, with their names and bytes',
	taken.files.length === 2 && taken.files[0].name === 'photo.jpg' && (await taken.files[0].text()) === 'first bytes'
	&& taken.files[1].type === 'video/mp4' && (await taken.files[1].text()) === 'second');
check('and empties the cache, so a share is offered once', (await takeShare()) === null && !store.has('peerkit-share'));

// A link shared with no file at all.
const link = new FormData();
link.append('url', 'https://example.com/b');
await worker.request(new Request(`${SCOPE}share-target`, { method: 'POST', body: link }));
const onlyText = await takeShare();
check('a shared link with no file is text on its own', onlyText.text === 'https://example.com/b' && onlyText.files.length === 0);

// Something else on this origin writing the same cache, and a share from another day.
const stale = await caches.open('peerkit-share');
await stale.put(`${SCOPE}share-index`, new Response(JSON.stringify({ at: Date.now() - 2 * 3600 * 1000, files: [] })));
check('a share older than an hour is ignored', (await peekShare()) === null);
await stale.put(`${SCOPE}share-index`, new Response('{ not json'));
check('and so is a broken one', (await peekShare()) === null);
await stale.put(`${SCOPE}share-index`, new Response(JSON.stringify({ at: Date.now(), files: [{ key: '../elsewhere', name: 'x' }] })));
check('a file key that is not one the worker writes is dropped', (await peekShare()) === null);
await dropShare();

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
