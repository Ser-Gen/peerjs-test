import { Emitter } from '../../emitter.js';
import { CH } from '../../protocol.js';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const PART_CHARS = 12000; // base64url characters per message; peerjs refuses JSON messages over ~16 KB
const MAX_PARTS = 4096; // about 36 MB of binary
const HIGH_WATER = 256 * 1024; // don't pile more than this on the control connection: pings share it
const PACE_MS = 50;

/*
 * Protocol (ch: 'doc'). y-protocols messages as in y-websocket: [varUint 0 = sync | 1 = awareness][payload].
 *   msg  {data}                   one message, base64url
 *   part {id, part, parts, data}  a long message in base64url slices, sent in order
 * On every link up both sides send sync step 1 and their awareness state, so only missing changes cross
 * and edits made while apart merge. Updates are sent even between link up and the 'connected' state:
 * the other side may already have answered our state, and a dropped update would wait for the next link.
 */

/**
 * Keeps one Y.Doc and its Awareness in sync with the paired device over the session's control channel.
 * `lib` is the vendor/editor.js module. Events: 'synced' after the first sync step 2 of a link.
 */
export class DocProvider extends Emitter {
	constructor({ lib, session, doc, awareness }) {
		super();
		this.lib = lib;
		this.session = session;
		this.doc = doc;
		this.awareness = awareness;
		this.connected = false;
		this.synced = false;
		this.queue = [];
		this.flushTimer = null;
		this.nextId = 1;
		this.incoming = null; // { id, parts, chunks } of a split message
		this.remoteClients = new Set();

		this.onUpdate = (update, origin) => {
			if (origin !== this) this.sendSync(encoder => lib.syncProtocol.writeUpdate(encoder, update));
		};
		this.onAwareness = ({ added, updated, removed }, origin) => {
			if (origin === this) {
				for (const id of [...added, ...updated]) this.remoteClients.add(id);
				for (const id of removed) this.remoteClients.delete(id);
				return;
			}
			// 1-to-1: only our own state goes out; the other device knows its own.
			if ([...added, ...updated, ...removed].includes(doc.clientID)) this.sendAwareness();
		};
		doc.on('update', this.onUpdate);
		awareness.on('update', this.onAwareness);
		this.unsubscribe = [
			session.onMessage(CH.DOC, msg => this.receive(msg)),
			session.on('state', () => this.onState()),
		];
		this.onState();
	}

	destroy() {
		// Tell the other device our cursor is gone before letting go.
		this.lib.awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy');
		this.unsubscribe.forEach(fn => fn());
		this.doc.off('update', this.onUpdate);
		this.awareness.off('update', this.onAwareness);
		clearTimeout(this.flushTimer);
		this.dropRemote();
	}

	onState() {
		const connected = this.session.state === 'connected';
		if (connected === this.connected) return;
		this.connected = connected;
		if (connected) {
			this.sendSync(encoder => this.lib.syncProtocol.writeSyncStep1(encoder, this.doc));
			// Re-setting the state bumps its clock, so the other device accepts it even if it saw this clock before.
			const state = this.awareness.getLocalState();
			if (state) this.awareness.setLocalState(state);
			return;
		}
		// The next link starts over with step 1, which recovers anything that was still queued.
		this.synced = false;
		this.queue = [];
		clearTimeout(this.flushTimer);
		this.flushTimer = null;
		this.incoming = null;
		this.dropRemote();
	}

	dropRemote() {
		const clients = [...this.remoteClients];
		if (clients.length) this.lib.awarenessProtocol.removeAwarenessStates(this.awareness, clients, this);
		// Forget their clocks too: after a reconnect the same state may come again with the same clock.
		for (const id of clients) this.awareness.meta.delete(id);
		this.remoteClients.clear();
	}

	// --- sending ---

	sendSync(write) {
		const { encoding } = this.lib;
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MSG_SYNC);
		write(encoder);
		this.enqueue(encoding.toUint8Array(encoder));
	}

	sendAwareness() {
		const { encoding, awarenessProtocol } = this.lib;
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MSG_AWARENESS);
		encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
		this.enqueue(encoding.toUint8Array(encoder));
	}

	enqueue(bytes) {
		if (!this.session.ctl?.open) return; // not linked: the next link's step 1 covers it
		const data = toBase64url(bytes);
		if (data.length <= PART_CHARS) {
			this.queue.push({ type: 'msg', data });
		} else {
			const id = this.nextId++;
			const parts = Math.ceil(data.length / PART_CHARS);
			for (let part = 0; part < parts; part++) {
				this.queue.push({ type: 'part', id, part, parts, data: data.slice(part * PART_CHARS, (part + 1) * PART_CHARS) });
			}
		}
		if (!this.flushTimer) this.flush();
	}

	flush() {
		this.flushTimer = null;
		while (this.queue.length) {
			if (this.session.controlBuffered > HIGH_WATER) {
				this.flushTimer = setTimeout(() => this.flush(), PACE_MS);
				return;
			}
			if (!this.session.send(CH.DOC, this.queue.shift())) {
				this.queue = [];
				return;
			}
		}
	}

	// --- receiving ---

	receive(msg) {
		if (msg.type === 'msg') {
			if (typeof msg.data === 'string') this.handle(msg.data);
			return;
		}
		if (msg.type !== 'part') return;
		const { id, part, parts, data } = msg;
		if (!Number.isInteger(parts) || parts < 2 || parts > MAX_PARTS || !Number.isInteger(part) || part < 0 || part >= parts || typeof data !== 'string') return;
		if (part === 0) this.incoming = { id, parts, chunks: [] };
		const incoming = this.incoming;
		// Parts of one message arrive in order on the reliable channel; anything else is a leftover.
		if (!incoming || incoming.id !== id || incoming.parts !== parts || incoming.chunks.length !== part) {
			this.incoming = null;
			return;
		}
		incoming.chunks.push(data);
		if (incoming.chunks.length === parts) {
			this.incoming = null;
			this.handle(incoming.chunks.join(''));
		}
	}

	handle(data) {
		const { encoding, decoding, syncProtocol, awarenessProtocol } = this.lib;
		try {
			const decoder = decoding.createDecoder(fromBase64url(data));
			const kind = decoding.readVarUint(decoder);
			if (kind === MSG_SYNC) {
				const reply = encoding.createEncoder();
				encoding.writeVarUint(reply, MSG_SYNC);
				const type = syncProtocol.readSyncMessage(decoder, reply, this.doc, this);
				if (encoding.length(reply) > 1) this.enqueue(encoding.toUint8Array(reply)); // step 1 is answered with step 2
				if (type === syncProtocol.messageYjsSyncStep2 && !this.synced) {
					this.synced = true;
					this.emit('synced');
				}
			} else if (kind === MSG_AWARENESS) {
				awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
			}
		} catch (err) {
			console.warn('[peerkit] bad doc message', err);
		}
	}
}

export function toBase64url(bytes) {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(data) {
	if (!/^[A-Za-z0-9_-]*$/.test(data)) throw new Error('not base64url');
	const binary = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
