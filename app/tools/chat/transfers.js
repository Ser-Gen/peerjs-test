import { Emitter } from '../../emitter.js';
import { CH } from '../../protocol.js';
import { wakeLock } from '../../util.js';
import { TreeHasher } from './kept.js';
import { cleanFileName, cleanType } from './timeline.js';

const CONSOLIDATE_BYTES = 16 * 1024 * 1024; // fold chunks into Blobs so the browser can page them out of RAM
const HEADER_BYTES = 4; // u32 transfer id in front of every binary chunk
const WANT_TIMEOUT = 15000; // a member that doesn't answer a request in this time is skipped
const MAX_ID = 0xffffffff;
const ID_RE = /^[0-9a-f]{16}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
export const FINAL = new Set(['delivered', 'received', 'cancelled', 'cancelled-remote', 'failed']);

/*
 * Protocol (ch: 'transfer'). The bytes of files, over the link with each member. Which files there are is in
 * the chat (the room document), so a file is always named by its chat entry id (`file`).
 *   offer    {id, file, name, size, mime, keep, hash, req?}  sender → receiver; `req` answers a `want`
 *   accept   {id}         receiver → sender; chunks start only after this
 *   complete {id}         receiver → sender once all bytes arrived
 *   abort    {id, dir}    dir is the aborting side's view: 'out' = its outgoing transfer
 *   want     {req, file}  asks a member that keeps a file for a copy
 *   queued   {req}        it has it, and sends it once the files ahead of it are done
 *   none     {req}        it doesn't have it (any more), or can't read it
 * Chunks go over the file connection as [u32 id][bytes]. Transfer ids are per sending device, so incoming ones
 * are keyed by sender and id. A new file goes to each member one at a time, to all members in parallel;
 * requests are answered one at a time, so several members fetching from one phone don't split its upload.
 */

export class RateMeter {
	samples = [];

	add(bytes) {
		const now = performance.now();
		this.samples.push([now, bytes]);
		while (this.samples.length > 2 && now - this.samples[0][0] > 3000) this.samples.shift();
	}

	get rate() {
		if (this.samples.length < 2) return 0;
		const [t0, b0] = this.samples[0];
		const [t1, b1] = this.samples[this.samples.length - 1];
		return t1 > t0 ? ((b1 - b0) * 1000) / (t1 - t0) : 0;
	}
}

/** An incoming file held in memory for this page. With `hash`, the bytes are checked against it. */
export class MemorySink {
	constructor(type, hash = null) {
		this.type = type || 'application/octet-stream';
		this.hasher = hash ? new TreeHasher() : null;
		this.expected = hash;
		this.parts = [];
		this.partsBytes = 0;
		this.blobs = [];
	}

	write(bytes) {
		this.hasher?.update(bytes);
		this.parts.push(bytes);
		this.partsBytes += bytes.byteLength;
		if (this.partsBytes >= CONSOLIDATE_BYTES) {
			this.blobs.push(new Blob(this.parts));
			this.parts = [];
			this.partsBytes = 0;
		}
	}

	async finish() {
		const file = new Blob([...this.blobs, ...this.parts], { type: this.type });
		this.parts = this.blobs = null;
		if (this.hasher && (await this.hasher.finish()) !== this.expected) {
			const err = new Error('The copy didn’t match the original');
			err.code = 'mismatch';
			throw err;
		}
		return { file, stored: false };
	}

	abort() {
		this.parts = this.blobs = null;
	}
}

const inKey = (peerId, id) => `${peerId}:${id}`;

/**
 * Moves files between this device and the others. The chat decides where they come from and go to:
 *   source(fileId) → Promise<{file: Blob, meta} | null>   this device's copy, to answer a request
 *   sink(meta, member) → Promise<{write, finish, abort}>   where an incoming file goes (see MemorySink)
 * Events: 'change' (fileId) for anything that changes the progress of a file; 'received' (fileId, {file, stored}).
 */
export class Transfers extends Emitter {
	constructor(room, { source, sink }) {
		super();
		this.room = room;
		this.source = source;
		this.sink = sink;
		this.nextId = 1;
		this.nextReq = 1;
		this.outgoing = new Map(); // fileId → { fileId, meta, file, sends: Map(peerId → send) }
		this.byId = new Map(); // transfer id → [item, send]
		this.incoming = new Map(); // `${peerId}:${id}` → item
		this.inByFile = new Map(); // fileId → the latest incoming item for it
		this.requests = new Map(); // req → { fileId, holders, member, timer, resolve, reject }
		this.queues = new Map(); // peerId, or 'serve' for answers to requests → { jobs: [], pumping }
		this.destroyed = false;
		this.unsubscribe = [
			room.on(`msg:${CH.TRANSFER}`, (msg, member) => this.onMessage(msg, member)),
			room.on('binary', (data, member) => this.onChunk(data, member)),
			room.on('link-down', member => this.onLinkDown(member)),
		];
	}

	destroy() {
		this.destroyed = true;
		this.unsubscribe.forEach(fn => fn());
		for (const item of this.outgoing.values()) for (const send of item.sends.values()) if (!FINAL.has(send.state)) this.stopSend(item, send, 'failed');
		for (const item of this.incoming.values()) if (!FINAL.has(item.state)) this.stopIncoming(item, 'failed');
		for (const request of this.requests.values()) this.endRequest(request, new Error('closed'));
	}

	// --- what the chat shows ---

	/** The newest incoming transfer of a file, and the sends of it from here. */
	status(fileId) {
		return { incoming: this.inByFile.get(fileId) ?? null, outgoing: this.outgoing.get(fileId) ?? null, fetching: [...this.requests.values()].some(r => r.fileId === fileId) };
	}

	bufferedFor(send) {
		return Math.max(0, send.done - this.room.bufferedAmount(send.member.peerId));
	}

	// --- sending ---

	/** Send a file that was just added to the chat to these members, each over its own link. */
	push(meta, file, members) {
		const item = this.outItem(meta, file);
		for (const member of members) this.queue(member.peerId, item, this.newSend(item, member));
		this.emit('change', meta.file);
	}

	outItem(meta, file) {
		let item = this.outgoing.get(meta.file);
		if (!item) this.outgoing.set(meta.file, (item = { fileId: meta.file, meta, file, sends: new Map() }));
		item.file = file;
		return item;
	}

	newSend(item, member, req = null) {
		const send = { id: this.nextId++, member, req, state: 'queued', done: 0, sent: 0, meter: new RateMeter(), locked: false };
		// A second send to the same member (a request after a push) replaces the finished first one on the card.
		const previous = item.sends.get(member.peerId);
		if (previous && !FINAL.has(previous.state)) this.stopSend(item, previous, 'cancelled');
		item.sends.set(member.peerId, send);
		this.byId.set(send.id, [item, send]);
		return send;
	}

	queue(key, item, send) {
		if (!this.queues.has(key)) this.queues.set(key, { jobs: [], pumping: false });
		this.queues.get(key).jobs.push([item, send]);
		this.pump(key);
	}

	/** One file at a time per queue: per member for new files, and one queue for all requests. */
	async pump(key) {
		const queue = this.queues.get(key);
		if (queue.pumping) return;
		queue.pumping = true;
		try {
			while (queue.jobs.length && !this.destroyed) {
				const [item, send] = queue.jobs.shift();
				if (send.state === 'queued') await this.sendFile(item, send);
			}
		} finally {
			queue.pumping = false;
		}
	}

	async sendFile(item, send) {
		const { room } = this;
		const to = send.member.peerId;
		const accepted = new Promise(resolve => {
			send.onAccept = () => resolve(true);
			send.onStop = () => resolve(false);
		});
		this.setSendState(item, send, 'offered');
		const { file: fileId, name, size, type, keep, hash } = item.meta;
		const offer = { type: 'offer', id: send.id, file: fileId, name, size, mime: type ?? '', keep, hash: hash ?? null };
		if (send.req != null) offer.req = send.req;
		if (!room.send(CH.TRANSFER, offer, to)) {
			this.stopSend(item, send, 'failed');
			return;
		}
		if (!(await accepted) || send.state !== 'offered') return;

		this.setSendState(item, send, 'sending');
		this.lock(send);
		try {
			const chunkSize = room.maxMessageSize(to) - HEADER_BYTES;
			let offset = 0;
			while (offset < size) {
				// Read one slice at a time: the file is never fully loaded into memory.
				const buf = await item.file.slice(offset, offset + chunkSize).arrayBuffer();
				if (send.state !== 'sending') return;
				const frame = new Uint8Array(HEADER_BYTES + buf.byteLength);
				new DataView(frame.buffer).setUint32(0, send.id);
				frame.set(new Uint8Array(buf), HEADER_BYTES);
				await room.sendBinary(to, frame);
				if (send.state !== 'sending') return;
				offset += buf.byteLength;
				send.done = offset;
				send.sent = this.bufferedFor(send);
				send.meter.add(send.sent);
				this.emit('progress', item.fileId);
			}
			if (send.state === 'sending') this.setSendState(item, send, 'finishing');
		} catch (err) {
			if (send.state !== 'sending') return;
			const readError = err instanceof DOMException && err.name !== 'NetworkError' ? err : null;
			if (readError) {
				send.error = 'Could not read the file';
				room.send(CH.TRANSFER, { type: 'abort', id: send.id, dir: 'out' }, to);
			}
			this.stopSend(item, send, 'failed');
		} finally {
			this.unlock(send);
		}
	}

	cancelOutgoing(fileId) {
		const item = this.outgoing.get(fileId);
		if (!item) return;
		for (const send of item.sends.values()) {
			if (FINAL.has(send.state)) continue;
			const notify = send.state !== 'queued';
			this.stopSend(item, send, 'cancelled');
			if (notify) this.room.send(CH.TRANSFER, { type: 'abort', id: send.id, dir: 'out' }, send.member.peerId);
		}
	}

	stopSend(item, send, state) {
		this.setSendState(item, send, state);
		this.unlock(send);
		send.onStop?.();
	}

	setSendState(item, send, state) {
		send.state = state;
		if (state === 'sending') send.startedAt = performance.now();
		if (state === 'delivered') send.endedAt = performance.now();
		if (FINAL.has(state)) this.byId.delete(send.id);
		this.emit('change', item.fileId);
	}

	// --- requests for kept files ---

	/**
	 * Get a copy of a kept file from one of `holders` (members online now), trying them in turn.
	 * Resolves with what the sink made of it; rejects when none of them could send it.
	 */
	fetch(fileId, holders) {
		return new Promise((resolve, reject) => {
			const request = { req: this.nextReq++, fileId, holders: [...holders], member: null, timer: null, resolve, reject };
			this.requests.set(request.req, request);
			this.askNext(request);
			this.emit('change', fileId);
		});
	}

	askNext(request) {
		clearTimeout(request.timer);
		const member = request.holders.shift();
		if (!member) {
			this.endRequest(request, Object.assign(new Error('Nobody online could send it'), { code: 'unavailable' }));
			return;
		}
		request.member = member;
		if (!this.room.send(CH.TRANSFER, { type: 'want', req: request.req, file: request.fileId }, member.peerId)) {
			this.askNext(request);
			return;
		}
		// Waiting in a busy member's queue is fine (it says `queued`); silence is not.
		request.timer = setTimeout(() => {
			if (!request.item) this.askNext(request);
		}, WANT_TIMEOUT);
	}

	endRequest(request, error, result) {
		clearTimeout(request.timer);
		if (!this.requests.delete(request.req)) return;
		if (error) request.reject(error);
		else request.resolve(result);
		this.emit('change', request.fileId);
	}

	async onWant(msg, member) {
		if (!Number.isInteger(msg.req) || !ID_RE.test(msg.file)) return;
		let found = null;
		try {
			found = await this.source(msg.file);
		} catch {
			found = null;
		}
		if (this.destroyed) return;
		if (!found || !this.room.member(member.peerId)) {
			this.room.send(CH.TRANSFER, { type: 'none', req: msg.req }, member.peerId);
			return;
		}
		const item = this.outItem({ file: msg.file, ...found.meta }, found.file);
		this.room.send(CH.TRANSFER, { type: 'queued', req: msg.req }, member.peerId);
		this.queue('serve', item, this.newSend(item, member, msg.req));
		this.emit('change', msg.file);
	}

	// --- receiving ---

	onMessage(msg, member) {
		switch (msg.type) {
			case 'offer':
				return this.onOffer(msg, member);
			case 'accept':
				return this.sendOf(msg.id, member)?.[1].onAccept?.();
			case 'complete': {
				const found = this.sendOf(msg.id, member);
				if (found && (found[1].state === 'sending' || found[1].state === 'finishing')) this.setSendState(found[0], found[1], 'delivered');
				return;
			}
			case 'abort': {
				if (msg.dir === 'out') {
					const item = this.incoming.get(inKey(member.peerId, msg.id));
					if (item && !FINAL.has(item.state)) this.stopIncoming(item, 'cancelled-remote');
				} else {
					const found = this.sendOf(msg.id, member);
					if (found && !FINAL.has(found[1].state)) this.stopSend(found[0], found[1], 'cancelled-remote');
				}
				return;
			}
			case 'want':
				return this.onWant(msg, member);
			case 'queued': {
				const request = this.requests.get(msg.req);
				if (request && request.member?.peerId === member.peerId) clearTimeout(request.timer);
				return;
			}
			case 'none': {
				const request = this.requests.get(msg.req);
				if (request && request.member?.peerId === member.peerId && !request.item) this.askNext(request);
			}
		}
	}

	sendOf(id, member) {
		const found = this.byId.get(id);
		return found && found[1].member.peerId === member.peerId ? found : null;
	}

	async onOffer(msg, member) {
		const size = Number(msg.size);
		if (!Number.isInteger(msg.id) || msg.id < 1 || msg.id > MAX_ID || !Number.isSafeInteger(size) || size < 0 || !ID_RE.test(msg.file)) return;
		const keep = msg.keep === true;
		if (keep && !HASH_RE.test(msg.hash)) return;
		let request = null;
		if (msg.req != null) {
			request = this.requests.get(msg.req);
			// An answer to a request that has moved on to someone else: say no, so the sender doesn't wait.
			if (!request || request.member?.peerId !== member.peerId || request.fileId !== msg.file || request.item) {
				this.room.send(CH.TRANSFER, { type: 'abort', id: msg.id, dir: 'in' }, member.peerId);
				return;
			}
			clearTimeout(request.timer);
		}
		// One copy of a file comes in at a time: both would be written to the same place.
		const current = this.inByFile.get(msg.file);
		if (current && !FINAL.has(current.state) && current.from.peerId !== member.peerId) {
			this.room.send(CH.TRANSFER, { type: 'abort', id: msg.id, dir: 'in' }, member.peerId);
			if (request) this.retryOrEnd(request, new Error('Already coming from another member'));
			return;
		}
		const key = inKey(member.peerId, msg.id);
		const previous = this.incoming.get(key);
		if (previous && !FINAL.has(previous.state)) this.stopIncoming(previous, 'failed');

		const meta = { file: msg.file, name: cleanFileName(msg.name), size, type: cleanType(msg.mime), keep, hash: keep ? msg.hash : null };
		const item = { key, id: msg.id, fileId: msg.file, from: member, meta, size, done: 0, state: 'receiving', sink: null, meter: new RateMeter(), locked: false, request };
		if (request) request.item = item;
		this.incoming.set(key, item);
		this.inByFile.set(msg.file, item);
		this.emit('change', msg.file);
		try {
			item.sink = await this.sink(meta, member);
		} catch (err) {
			console.warn('[peerkit] no place for an incoming file', err);
		}
		if (item.state !== 'receiving') return item.sink?.abort();
		if (!item.sink) {
			this.cancelIncoming(msg.file);
			return;
		}
		this.room.send(CH.TRANSFER, { type: 'accept', id: item.id }, member.peerId);
		item.startedAt = performance.now();
		if (size === 0) this.finishIncoming(item);
		else this.lock(item);
	}

	onChunk(data, member) {
		if (!(data instanceof ArrayBuffer) || data.byteLength < HEADER_BYTES) return;
		const item = this.incoming.get(inKey(member.peerId, new DataView(data).getUint32(0)));
		if (!item || item.state !== 'receiving' || !item.sink) return;
		const bytes = new Uint8Array(data, HEADER_BYTES);
		if (item.done + bytes.byteLength > item.size) {
			this.cancelIncoming(item.fileId); // more than it said it would send
			return;
		}
		item.sink.write(bytes);
		item.done += bytes.byteLength;
		item.meter.add(item.done);
		if (item.done === item.size) this.finishIncoming(item);
		else this.emit('progress', item.fileId);
	}

	async finishIncoming(item) {
		item.state = 'checking';
		this.unlock(item);
		this.room.send(CH.TRANSFER, { type: 'complete', id: item.id }, item.from.peerId);
		this.emit('change', item.fileId);
		try {
			const result = await item.sink.finish();
			item.state = 'received';
			item.endedAt = performance.now();
			this.emit('received', item.fileId, result, item);
			if (item.request) this.endRequest(item.request, null, result);
		} catch (err) {
			item.state = 'failed';
			item.error = err?.code === 'mismatch' ? 'The copy didn’t match the original, so it wasn’t kept' : 'Could not store it on this device';
			console.warn('[peerkit] incoming file not kept', err);
			if (item.request) this.retryOrEnd(item.request, err);
		}
		this.emit('change', item.fileId);
	}

	/** The copy from one member failed: another may have a good one. */
	retryOrEnd(request, err) {
		request.item = null;
		if (request.holders.length) this.askNext(request);
		else this.endRequest(request, err);
	}

	cancelIncoming(fileId) {
		const item = this.inByFile.get(fileId);
		if (item && !FINAL.has(item.state) && item.state !== 'checking') {
			this.stopIncoming(item, 'cancelled');
			this.room.send(CH.TRANSFER, { type: 'abort', id: item.id, dir: 'in' }, item.from.peerId);
		}
		for (const request of [...this.requests.values()]) if (request.fileId === fileId) this.endRequest(request, Object.assign(new Error('Cancelled'), { code: 'cancelled' }));
	}

	stopIncoming(item, state) {
		item.state = state;
		this.unlock(item);
		item.sink?.abort();
		if (item.request) {
			if (state === 'failed') this.retryOrEnd(item.request, new Error('Interrupted'));
			else if (state === 'cancelled-remote') this.retryOrEnd(item.request, new Error('Cancelled by the sender'));
		}
		this.emit('change', item.fileId);
	}

	/** Forget a file entirely, e.g. once it was removed from the room. */
	drop(fileId) {
		this.cancelOutgoing(fileId);
		this.cancelIncoming(fileId);
		this.outgoing.delete(fileId);
		this.inByFile.delete(fileId);
	}

	onLinkDown(member) {
		for (const item of this.outgoing.values()) {
			const send = item.sends.get(member.peerId);
			if (send && !FINAL.has(send.state)) this.stopSend(item, send, 'failed');
		}
		for (const item of this.incoming.values()) {
			if (item.from.peerId === member.peerId && !FINAL.has(item.state) && item.state !== 'checking') this.stopIncoming(item, 'failed');
		}
		for (const request of [...this.requests.values()]) {
			if (request.member?.peerId === member.peerId && !request.item) this.askNext(request);
		}
		this.queues.delete(member.peerId);
	}

	lock(holder) {
		if (holder.locked) return;
		holder.locked = true;
		wakeLock.acquire();
	}

	unlock(holder) {
		if (!holder.locked) return;
		holder.locked = false;
		wakeLock.release();
	}
}
