import { cleanName } from '../../device.js';
import { Emitter } from '../../emitter.js';
import { memberColor } from '../../room.js';
import { randomId } from '../../util.js';

export const MAX_MESSAGES = 5000;
export const MAX_TEXT = 50000; // characters in one message; longer text is a file or a document
const ID_RE = /^[0-9a-f]{16}$/;
const DEVICE_RE = /^[0-9a-f]{8,64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const TYPE_RE = /^[a-z0-9][\w.+-]*\/[\w.+-]+$/i;

/*
 * The chat, in the room document (app/roomdoc.js):
 *   array 'chat'    messages, oldest first; beyond MAX_MESSAGES the oldest go, trimmed the same way on every device
 *     {id, kind: 'text', from, name, time, text}
 *     {id, kind: 'file', from, name, time, file: {name, size, type, keep, hash}}   `hash` only when `keep`
 *   map 'held'      `${file id}:${device ID}` → {name, time}: the devices that keep a copy of a kept file
 *   map 'removed'   file id → {by, from, time}: "Remove from room"; every device deletes its copy
 * `from` is the sender's device ID and `name` its name at the time. All of it comes from members, so all of it is checked.
 */

export const cleanFileName = name => String(name ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 255) || 'file';

export const cleanType = type => (typeof type === 'string' && type.length <= 100 && TYPE_RE.test(type) ? type.toLowerCase() : '');

function readFile(raw) {
	if (!raw || typeof raw !== 'object') return null;
	if (!Number.isSafeInteger(raw.size) || raw.size < 0) return null;
	const keep = raw.keep === true;
	if (keep && !HASH_RE.test(raw.hash)) return null;
	return { name: cleanFileName(raw.name), size: raw.size, type: cleanType(raw.type), keep, hash: keep ? raw.hash : null };
}

export function readMessage(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const { id, kind, from, time } = raw;
	if (!ID_RE.test(id) || !DEVICE_RE.test(from) || !Number.isFinite(time)) return null;
	const base = { id, kind, from, time, name: cleanName(raw.name) || 'Device', color: memberColor(from) };
	if (kind === 'text') return typeof raw.text === 'string' && raw.text.trim() ? { ...base, text: raw.text.slice(0, MAX_TEXT) } : null;
	if (kind === 'file') {
		const file = readFile(raw.file);
		return file ? { ...base, file } : null;
	}
	return null;
}

const readCache = new WeakMap(); // Yjs hands out the same object for a message every time

function readCached(raw) {
	if (!raw || typeof raw !== 'object') return null;
	if (!readCache.has(raw)) readCache.set(raw, readMessage(raw));
	return readCache.get(raw);
}

/**
 * The chat's messages and file bookkeeping on top of the room document. `self` is the room's own member
 * (device ID and current name). Events:
 *   'change' ({added, deleted, remote})  messages came or went; `remote` when they came from a member
 *   'held'                               who keeps which file changed
 *   'removed' (file ids, remote)         files were removed from the room
 */
export class Timeline extends Emitter {
	constructor(roomDoc, self) {
		super();
		this.roomDoc = roomDoc;
		this.self = self;
		const { doc } = roomDoc;
		this.chat = doc.getArray('chat');
		this.heldMap = doc.getMap('held');
		this.removedMap = doc.getMap('removed');
		this.cache = null;
		this.index = null;
		this.holderIndex = null;
		this.trimQueued = false;
		this.chat.observe((event, transaction) => this.onChat(event, transaction));
		this.heldMap.observe(() => {
			this.holderIndex = null;
			this.emit('held');
		});
		this.removedMap.observe((event, transaction) => this.emit('removed', [...event.keysChanged], roomDoc.isRemote(transaction.origin)));
		this.queueTrim();
	}

	onChat(event, transaction) {
		this.cache = this.index = null;
		const read = items => [...items].flatMap(item => item.content.getContent().map(readCached).filter(Boolean));
		this.emit('change', { added: read(event.changes.added), deleted: read(event.changes.deleted), remote: this.roomDoc.isRemote(transaction.origin) });
		this.queueTrim();
	}

	// --- reading ---

	messages() {
		this.cache ??= this.chat.toArray().map(readCached).filter(Boolean);
		return this.cache;
	}

	message(id) {
		this.index ??= new Map(this.messages().map(msg => [msg.id, msg]));
		return this.index.get(id) ?? null;
	}

	removed(fileId) {
		const raw = this.removedMap.get(fileId);
		if (!raw) return null;
		return { by: cleanName(raw.by) || 'Someone', from: DEVICE_RE.test(raw.from) ? raw.from : null, time: Number.isFinite(raw.time) ? raw.time : 0 };
	}

	/** The devices that keep a copy of a file: [{deviceId, name}]. */
	holders(fileId) {
		if (!this.holderIndex) {
			this.holderIndex = new Map();
			for (const [key, value] of this.heldMap) {
				const [id, deviceId] = key.split(':');
				if (!ID_RE.test(id) || !DEVICE_RE.test(deviceId)) continue;
				if (!this.holderIndex.has(id)) this.holderIndex.set(id, []);
				this.holderIndex.get(id).push({ deviceId, name: cleanName(value?.name) || 'Device' });
			}
		}
		return this.holderIndex.get(fileId) ?? [];
	}

	/** Ids of the files this device is listed as keeping. */
	heldHere() {
		const suffix = `:${this.self.deviceId}`;
		return [...this.heldMap.keys()].filter(key => key.endsWith(suffix)).map(key => key.slice(0, -suffix.length));
	}

	// --- writing ---

	base(kind) {
		return { id: randomId(8), kind, from: this.self.deviceId, name: this.self.name, time: Date.now() };
	}

	addText(text) {
		const msg = { ...this.base('text'), text: text.slice(0, MAX_TEXT) };
		this.chat.push([msg]);
		return msg;
	}

	/** `file`: {name, size, type, keep, hash}. The id can be chosen first, so the copy kept here is named by it. */
	addFile(file, id = randomId(8)) {
		const msg = { ...this.base('file'), id, file: { name: cleanFileName(file.name), size: file.size, type: cleanType(file.type), keep: file.keep, hash: file.keep ? file.hash : null } };
		this.chat.push([msg]);
		return msg;
	}

	/** Mark a file removed. Every device deletes its copy, so nobody is listed as keeping it any more. */
	remove(fileId) {
		this.roomDoc.doc.transact(() => {
			this.removedMap.set(fileId, { by: this.self.name, from: this.self.deviceId, time: Date.now() });
			for (const { deviceId } of this.holders(fileId)) this.heldMap.delete(`${fileId}:${deviceId}`);
		});
	}

	/** List (or unlist) this device as keeping a copy. */
	hold(fileId, held) {
		const key = `${fileId}:${this.self.deviceId}`;
		if (held && !this.heldMap.has(key)) this.heldMap.set(key, { name: this.self.name, time: Date.now() });
		else if (!held && this.heldMap.has(key)) this.heldMap.delete(key);
	}

	// --- trimming ---

	queueTrim() {
		if (this.trimQueued || this.chat.length <= MAX_MESSAGES) return;
		this.trimQueued = true;
		// Not inside an observer: this is a transaction of its own.
		setTimeout(() => {
			this.trimQueued = false;
			this.trim();
		});
	}

	/** Drop the oldest messages over the limit, and the bookkeeping of their files. Every device does the same. */
	trim(max = MAX_MESSAGES) {
		const over = this.chat.length - max;
		if (over <= 0 || this.roomDoc.destroyed) return;
		const gone = this.chat.slice(0, over).map(readCached).filter(msg => msg?.kind === 'file').map(msg => msg.id);
		this.roomDoc.doc.transact(() => {
			this.chat.delete(0, over);
			for (const id of gone) {
				this.removedMap.delete(id);
				for (const { deviceId } of this.holders(id)) this.heldMap.delete(`${id}:${deviceId}`);
			}
		});
	}
}
