import { sha256, toHex } from '../../crypto.js';
import { Emitter } from '../../emitter.js';
import { readJSON, writeJSON } from '../../util.js';

const SETTINGS_KEY = 'peerkit.files';
const SETTINGS_VERSION = 1;
const MB = 1024 * 1024;
const GB = 1024 * MB;
export const LIMITS = [500 * MB, 1 * GB, 2 * GB, 5 * GB, 10 * GB, 20 * GB];
const DEFAULT_LIMIT = 2 * GB;
const ROOT_DIR = 'peerkit-kept';
export const PART_BYTES = 4 * MB; // the hash is over the hashes of parts this size
const WRITE_BYTES = 1 * MB; // chunks arrive in 64 KB pieces; the disk gets them in pieces this size
const QUOTA_MARGIN = 64 * MB; // what the browser's own quota must leave over besides the file
const MAX_DROPPED = 200; // per room: the files this device dropped to make room, for the timeline to say so
const MAX_DROPPED_ROOMS = 50;
const ID_RE = /^[0-9a-f]{16}$/;
const ROOM_RE = /^[0-9a-f]{32}$/;

/*
 * Kept files: what "Keep for the room" stores on this device, in the origin private file system (OPFS),
 *   peerkit-kept/<room ID>/<chat entry id>
 * The chat entry carries the file's hash, so a copy from any member can be checked. The hash is SHA-256 over
 * the SHA-256 of each 4 MB part, so it is computed while the bytes arrive without holding the whole file.
 * One limit for all rooms (Settings → Kept files). When a new file needs space the oldest kept files go first,
 * wherever they came from; the room is told through `keptSettings` ('dropped'), now or when it opens next.
 */

export class KeepError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code; // 'unavailable' | 'space' | 'mismatch' | 'write'
	}
}

/** OPFS is there only in a secure context (not on http://<lan-ip>). */
export const canKeep = () => typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';

// --- settings: the limit, and what was dropped to stay under it ---

class KeptSettings extends Emitter {
	constructor() {
		super();
		const raw = readJSON(SETTINGS_KEY);
		const ok = raw?.version === SETTINGS_VERSION;
		this.limit = ok && LIMITS.includes(raw.limit) ? raw.limit : DEFAULT_LIMIT;
		this.dropped = {};
		if (ok && raw.dropped && typeof raw.dropped === 'object' && !Array.isArray(raw.dropped)) {
			for (const [room, ids] of Object.entries(raw.dropped)) {
				if (ROOM_RE.test(room) && Array.isArray(ids)) this.dropped[room] = ids.filter(id => ID_RE.test(id)).slice(-MAX_DROPPED);
			}
		}
	}

	save() {
		writeJSON(SETTINGS_KEY, { version: SETTINGS_VERSION, limit: this.limit, dropped: this.dropped });
	}

	async setLimit(limit) {
		if (!LIMITS.includes(limit) || limit === this.limit) return;
		this.limit = limit;
		this.save();
		this.emit('change');
		await makeRoom(0); // a lower limit drops the oldest files now
	}

	droppedIn(room) {
		return new Set(this.dropped[room] ?? []);
	}

	markDropped(room, id) {
		const ids = (this.dropped[room] ?? []).filter(other => other !== id);
		ids.push(id);
		delete this.dropped[room]; // re-insert, so the rooms seen longest ago are the first to be forgotten
		this.dropped[room] = ids.slice(-MAX_DROPPED);
		const rooms = Object.keys(this.dropped);
		for (const old of rooms.slice(0, Math.max(0, rooms.length - MAX_DROPPED_ROOMS))) delete this.dropped[old];
		this.save();
		this.emit('dropped', room, id);
	}

	clearDropped(room, id) {
		const ids = this.dropped[room];
		if (!ids?.includes(id)) return;
		this.dropped[room] = ids.filter(other => other !== id);
		if (!this.dropped[room].length) delete this.dropped[room];
		this.save();
	}

	forgetRoom(room) {
		if (!this.dropped[room]) return;
		delete this.dropped[room];
		this.save();
	}
}

export const keptSettings = new KeptSettings();

// --- hashing ---

async function digest(bytes) {
	// WebCrypto copies the bytes before it returns, so the caller may reuse its buffer.
	if (globalThis.crypto?.subtle) return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
	return sha256(bytes.slice()); // http://<lan-ip> has no WebCrypto
}

/** The hash of a file whose bytes come in pieces of any size: SHA-256 of the concatenated SHA-256s of its 4 MB parts. */
export class TreeHasher {
	constructor() {
		this.part = new Uint8Array(PART_BYTES);
		this.fill = 0;
		this.parts = [];
	}

	update(bytes) {
		for (let offset = 0; offset < bytes.byteLength;) {
			const n = Math.min(PART_BYTES - this.fill, bytes.byteLength - offset);
			this.part.set(bytes.subarray(offset, offset + n), this.fill);
			this.fill += n;
			offset += n;
			if (this.fill === PART_BYTES) this.cut();
		}
	}

	cut() {
		this.parts.push(digest(this.part.subarray(0, this.fill)));
		this.fill = 0;
	}

	async finish() {
		if (this.fill) this.cut();
		const parts = await Promise.all(this.parts);
		const all = new Uint8Array(parts.length * 32);
		parts.forEach((part, i) => all.set(part, i * 32));
		return toHex(await digest(all));
	}
}

export async function hashFile(file, onProgress = null) {
	const hasher = new TreeHasher();
	for (let offset = 0; offset < file.size; offset += PART_BYTES) {
		const bytes = new Uint8Array(await file.slice(offset, offset + PART_BYTES).arrayBuffer());
		hasher.update(bytes);
		onProgress?.(offset + bytes.byteLength);
	}
	return hasher.finish();
}

// --- the store ---

let persistAsked = false;

async function rootDir() {
	return (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT_DIR, { create: true });
}

async function entriesOf(dir) {
	const list = [];
	for await (const [name, handle] of dir.entries()) list.push([name, handle]);
	return list;
}

/** Every kept file on this device: [{room, id, size, time}], oldest first. */
async function allKept() {
	const files = [];
	for (const [room, dir] of await entriesOf(await rootDir())) {
		if (dir.kind !== 'directory') continue;
		for (const [id, handle] of await entriesOf(dir)) {
			if (handle.kind !== 'file') continue;
			try {
				const file = await handle.getFile();
				files.push({ room, id, size: file.size, time: file.lastModified, dir });
			} catch {
				// being written, or gone meanwhile
			}
		}
	}
	return files.sort((a, b) => a.time - b.time);
}

/** How much the kept files of all rooms take on this device. */
export async function keptUsage() {
	if (!canKeep()) return { bytes: 0, files: 0 };
	const files = await allKept();
	return { bytes: files.reduce((sum, file) => sum + file.size, 0), files: files.length };
}

const writing = new Set(); // `${room}/${id}` of files being written; never dropped to make room

/**
 * Drop the oldest kept files until `size` more fits under the limit. Throws KeepError('space') if it can't:
 * the file is bigger than the limit, or the browser's own quota is short.
 */
export async function makeRoom(size) {
	if (!canKeep()) return;
	const limit = keptSettings.limit;
	if (size > limit) throw new KeepError('space', 'Bigger than the space for kept files');
	const files = await allKept();
	let used = files.reduce((sum, file) => sum + file.size, 0);
	for (const file of files) {
		if (used + size <= limit) break;
		if (writing.has(`${file.room}/${file.id}`)) continue;
		try {
			await file.dir.removeEntry(file.id);
			used -= file.size;
			keptSettings.markDropped(file.room, file.id);
		} catch {
			// in use: try the next one
		}
	}
	if (used + size > limit) throw new KeepError('space', 'No space for kept files');
	const estimate = await navigator.storage.estimate?.().catch(() => null);
	if (estimate?.quota && estimate.quota - (estimate.usage ?? 0) < size + QUOTA_MARGIN) {
		throw new KeepError('space', 'The browser has no more space for this site');
	}
}

export async function deleteRoomFiles(room) {
	keptSettings.forgetRoom(room);
	if (!canKeep()) return;
	try {
		await (await rootDir()).removeEntry(room, { recursive: true });
	} catch {
		// nothing kept for it
	}
}

/** One room's kept files on this device. */
export class KeptStore {
	constructor(room) {
		this.room = room;
		this.dirPromise = null;
	}

	dir() {
		this.dirPromise ??= rootDir().then(root => root.getDirectoryHandle(this.room, { create: true }));
		this.dirPromise.catch(() => (this.dirPromise = null));
		return this.dirPromise;
	}

	/** The kept copy, if it is complete (a copy being written has another size). */
	async get(id, size) {
		try {
			const file = await (await (await this.dir()).getFileHandle(id)).getFile();
			return size == null || file.size === size ? file : null;
		} catch {
			return null;
		}
	}

	/** Map id → size of what this room has here. */
	async list() {
		const kept = new Map();
		for (const [id, handle] of await entriesOf(await this.dir())) {
			if (handle.kind !== 'file' || !ID_RE.test(id) || writing.has(`${this.room}/${id}`)) continue;
			try {
				kept.set(id, (await handle.getFile()).size);
			} catch {
				// gone meanwhile
			}
		}
		return kept;
	}

	async remove(id) {
		try {
			await (await this.dir()).removeEntry(id);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * A place to write a file of `size` bytes as it arrives. With `hash`, `finish()` checks the bytes against it and
	 * keeps nothing if they differ; without, it only computes the hash (the sender's own copy).
	 */
	async writer(id, { size, hash = null }) {
		if (!canKeep()) throw new KeepError('unavailable', 'This browser can’t keep files');
		const key = `${this.room}/${id}`;
		writing.add(key);
		try {
			await makeRoom(size);
			if (!persistAsked) {
				persistAsked = true;
				navigator.storage.persist?.().catch(() => {}); // so the browser doesn't clear kept files when space is short
			}
			const dir = await this.dir();
			const handle = await dir.getFileHandle(id, { create: true });
			const writable = await handle.createWritable({ keepExistingData: false });
			return new KeptWriter({ dir, handle, writable, id, hash, done: () => writing.delete(key) });
		} catch (err) {
			writing.delete(key);
			throw err instanceof KeepError ? err : new KeepError('write', err?.message ?? 'Could not store the file');
		}
	}
}

class KeptWriter {
	constructor({ dir, handle, writable, id, hash, done }) {
		Object.assign(this, { dir, handle, writable, id, expected: hash, done });
		this.hasher = new TreeHasher();
		this.pending = [];
		this.pendingBytes = 0;
		this.chain = Promise.resolve();
		this.error = null;
		this.closed = false;
	}

	write(bytes) {
		if (this.closed) return;
		this.hasher.update(bytes);
		this.pending.push(bytes.slice()); // the caller's buffer may be reused
		this.pendingBytes += bytes.byteLength;
		if (this.pendingBytes >= WRITE_BYTES) this.flush();
	}

	flush() {
		if (!this.pendingBytes) return;
		const data = new Uint8Array(this.pendingBytes);
		let offset = 0;
		for (const piece of this.pending) {
			data.set(piece, offset);
			offset += piece.byteLength;
		}
		this.pending = [];
		this.pendingBytes = 0;
		this.chain = this.chain
			.then(() => {
				if (!this.error && !this.closed) return this.writable.write(data);
			})
			.catch(err => {
				this.error ??= err;
			});
	}

	/** Resolves once what was written so far has gone to the disk, for a writer that can wait (the sender's own copy). */
	settle() {
		this.flush();
		return this.chain;
	}

	/** Resolves with the stored File and its hash; a copy that doesn't match is removed and throws 'mismatch'. */
	async finish() {
		this.flush();
		await this.chain;
		const hash = await this.hasher.finish();
		if (this.error || (this.expected && hash !== this.expected)) {
			const mismatch = !this.error;
			await this.abort();
			throw mismatch ? new KeepError('mismatch', 'The copy didn’t match the original') : new KeepError('write', String(this.error?.message ?? this.error));
		}
		this.closed = true;
		try {
			await this.writable.close();
			return { file: await this.handle.getFile(), hash };
		} catch (err) {
			await this.dir.removeEntry(this.id).catch(() => {});
			throw new KeepError('write', err?.message ?? 'Could not store the file');
		} finally {
			this.done();
		}
	}

	async abort() {
		if (this.closed) return;
		this.closed = true;
		this.pending = [];
		await this.chain;
		await this.writable.abort?.().catch(() => {});
		await this.dir.removeEntry(this.id).catch(() => {});
		this.done();
	}
}
