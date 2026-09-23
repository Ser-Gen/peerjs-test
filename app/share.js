/*
 * The app side of the Android share target. sw.js takes the POST from "Share → PeerKit", puts what came with
 * it in the cache named below and sends the browser to the app; this reads it back once. The two files must
 * agree on the cache name and the keys in it.
 * Everything here is untrusted: another page on this origin could write the same cache.
 */
const CACHE = 'peerkit-share';
const INDEX = 'share-index';
const MAX_AGE = 60 * 60 * 1000; // an hour: an older share was meant for another visit
const MAX_FILES = 50;

const key = name => new URL(name, location.href).href;

async function open() {
	// Cache storage is missing on http://<lan-ip> (not a secure context) and in private modes.
	if (!globalThis.caches) return null;
	try {
		return await caches.open(CACHE);
	} catch {
		return null;
	}
}

async function readIndex(cache) {
	const response = await cache.match(key(INDEX)).catch(() => null);
	if (!response) return null;
	const index = await response.json().catch(() => null);
	if (!index || typeof index !== 'object' || !Array.isArray(index.files)) return null;
	if (!(Date.now() - index.at < MAX_AGE)) return null;
	const files = [];
	for (const file of index.files.slice(0, MAX_FILES)) {
		if (!file || typeof file.key !== 'string' || !/^share-file-\d{1,3}$/.test(file.key)) continue;
		files.push({
			key: file.key,
			name: typeof file.name === 'string' && file.name ? file.name.slice(0, 255) : 'file',
			size: Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : 0,
			type: typeof file.type === 'string' ? file.type.slice(0, 255) : '',
		});
	}
	return { text: shareText(index), files };
}

/** Android sends a title, a text and a URL in any combination; a shared link often arrives as two of them. */
function shareText({ title, text, url }) {
	const parts = [];
	for (const part of [title, text, url]) {
		if (typeof part === 'string' && part.trim() && !parts.includes(part.trim())) parts.push(part.trim());
	}
	return parts.join('\n').slice(0, 20000);
}

/** What is waiting, for the notice on the start screen: no file contents are read. */
export async function peekShare() {
	const cache = await open();
	if (!cache) return null;
	const share = await readIndex(cache);
	return share && (share.text || share.files.length) ? share : null;
}

/** The same, with the files, and the cache emptied: a share is offered once. */
export async function takeShare() {
	const cache = await open();
	if (!cache) return null;
	const share = await readIndex(cache);
	const files = [];
	for (const file of share?.files ?? []) {
		const response = await cache.match(key(file.key)).catch(() => null);
		if (!response) continue;
		const blob = await response.blob();
		// A name makes it enough of a File for the Transfer tool, and the bytes stay in the blob store
		// instead of being copied into a new File.
		try {
			Object.defineProperty(blob, 'name', { value: file.name });
		} catch {
			continue;
		}
		files.push(blob);
	}
	// The blobs stay readable once the cache is gone: the browser's blob store keeps its own reference.
	await dropShare();
	if (!share || (!share.text && !files.length)) return null;
	return { text: share.text, files };
}

export function dropShare() {
	return globalThis.caches ? caches.delete(CACHE).catch(() => false) : Promise.resolve(false);
}
