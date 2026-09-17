import { Emitter } from '../../emitter.js';
import { CH } from '../../protocol.js';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const PART_CHARS = 12000; // base64url characters per message; peerjs refuses JSON messages over ~16 KB
const MAX_PARTS = 4096; // about 36 MB of binary
const HIGH_WATER = 256 * 1024; // don't pile more than this on a control connection: pings share it
const PACE_MS = 50;

/*
 * Protocol (ch: 'doc'). y-protocols messages as in y-websocket: [varUint 0 = sync | 1 = awareness][payload].
 *   msg  {data}                   one message, base64url
 *   part {id, part, parts, data}  a long message in base64url slices, sent in order
 * On every link up both sides send sync step 1 and their awareness, so only missing changes cross and
 * edits made while apart merge. Every member links to every other, so updates normally go straight to all.
 * When two members aren't linked (as far as the room knows), a member linked to both forwards what one sends;
 * Yjs ignores anything it already has.
 */

/** One link's sending queue and receiving state. It is also the Yjs origin of what arrives on it. */
class LinkState {
	constructor(provider, member) {
		this.provider = provider;
		this.peerId = member.peerId;
		this.synced = false;
		this.queue = [];
		this.flushTimer = null;
		this.nextId = 1;
		this.incoming = null; // { id, parts, chunks } of a split message
	}
}

/**
 * Keeps one Y.Doc and its Awareness in sync with every member of the room.
 * `lib` is the vendor/editor.js module. Events: 'synced' after the first sync step 2 from anyone.
 */
export class DocProvider extends Emitter {
	constructor({ lib, room, doc, awareness }) {
		super();
		this.lib = lib;
		this.room = room;
		this.doc = doc;
		this.awareness = awareness;
		this.synced = false;
		this.links = new Map(); // peerId → LinkState
		this.heardVia = new Map(); // awareness client ID → Set of peer IDs it came through

		this.onUpdate = (update, origin) => {
			const from = origin instanceof LinkState && origin.provider === this ? origin.peerId : null;
			this.sendSync(encoder => lib.syncProtocol.writeUpdate(encoder, update), from);
		};
		this.onAwareness = ({ added, updated, removed }, origin) => {
			const changed = [...added, ...updated, ...removed];
			if (origin instanceof LinkState && origin.provider === this) {
				for (const id of [...added, ...updated]) {
					if (!this.heardVia.has(id)) this.heardVia.set(id, new Set());
					this.heardVia.get(id).add(origin.peerId);
				}
				for (const id of removed) this.heardVia.delete(id);
				this.sendAwareness(changed, origin.peerId);
				return;
			}
			if (origin === this) return; // states dropped with a link: the others time out by themselves
			// Our own state: every member gets it from us directly.
			if (changed.includes(doc.clientID)) this.sendAwareness([doc.clientID]);
		};
		doc.on('update', this.onUpdate);
		awareness.on('update', this.onAwareness);
		this.unsubscribe = [
			room.on(`msg:${CH.DOC}`, (msg, member) => this.receive(msg, member)),
			room.on('link-up', member => this.linkUp(member)),
			room.on('link-down', member => this.linkDown(member)),
			room.on('links', member => this.onLinksChanged(member)),
		];
		for (const member of room.members) this.linkUp(member);
	}

	destroy() {
		// Tell the others our cursor is gone before letting go.
		this.destroying = true;
		this.lib.awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy');
		this.unsubscribe.forEach(fn => fn());
		this.doc.off('update', this.onUpdate);
		this.awareness.off('update', this.onAwareness);
		for (const member of [...this.links.keys()]) this.linkDown({ peerId: member });
	}

	linkUp(member) {
		if (this.links.has(member.peerId)) return this.links.get(member.peerId);
		const link = new LinkState(this, member);
		this.links.set(member.peerId, link);
		this.enqueue(link, this.encodeSync(encoder => this.lib.syncProtocol.writeSyncStep1(encoder, this.doc)));
		// Everyone we know about, so it also learns of members it isn't linked to.
		const clients = [...this.awareness.getStates().keys()];
		if (clients.length) this.enqueue(link, this.encodeAwareness(clients));
		return link;
	}

	linkDown(member) {
		const link = this.links.get(member.peerId);
		if (!link) return;
		this.links.delete(member.peerId);
		clearTimeout(link.flushTimer);
		link.queue = [];
		// States that only came through this link are gone. Forget their clocks too: after a reconnect
		// the same state may come again with the same clock.
		const gone = [];
		for (const [client, via] of this.heardVia) {
			via.delete(member.peerId);
			if (!via.size) gone.push(client);
		}
		for (const client of gone) this.heardVia.delete(client);
		if (gone.length) {
			this.lib.awarenessProtocol.removeAwarenessStates(this.awareness, gone, this);
			for (const client of gone) this.awareness.meta.delete(client);
		}
		// What the gone member sent us last may not have arrived; the others have it.
		if (!this.destroying) {
			const step1 = this.encodeSync(encoder => this.lib.syncProtocol.writeSyncStep1(encoder, this.doc));
			for (const other of this.links.values()) this.enqueue(other, step1);
		}
	}

	/** A member lost or gained direct links: it may now need what we forward, cursors included. */
	onLinksChanged(member) {
		const link = this.links.get(member.peerId);
		const clients = [...this.awareness.getStates().keys()];
		if (link && clients.length) this.enqueue(link, this.encodeAwareness(clients));
	}

	// --- sending ---

	encodeSync(write) {
		const { encoding } = this.lib;
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MSG_SYNC);
		write(encoder);
		return encoding.toUint8Array(encoder);
	}

	encodeAwareness(clients) {
		const { encoding, awarenessProtocol } = this.lib;
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MSG_AWARENESS);
		encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients));
		return encoding.toUint8Array(encoder);
	}

	/** To every link, or when it came from `from`, to those that aren't linked to `from`. */
	targets(from) {
		return [...this.links.values()].filter(link => link.peerId !== from && !(from && this.room.isLinked(from, link.peerId)));
	}

	sendSync(write, from = null) {
		const targets = this.targets(from);
		if (!targets.length) return;
		const bytes = this.encodeSync(write);
		for (const link of targets) this.enqueue(link, bytes);
	}

	sendAwareness(clients, from = null) {
		const targets = this.targets(from);
		if (!targets.length) return;
		const bytes = this.encodeAwareness(clients);
		for (const link of targets) this.enqueue(link, bytes);
	}

	enqueue(link, bytes) {
		const data = toBase64url(bytes);
		if (data.length <= PART_CHARS) {
			link.queue.push({ type: 'msg', data });
		} else {
			const id = link.nextId++;
			const parts = Math.ceil(data.length / PART_CHARS);
			for (let part = 0; part < parts; part++) {
				link.queue.push({ type: 'part', id, part, parts, data: data.slice(part * PART_CHARS, (part + 1) * PART_CHARS) });
			}
		}
		if (!link.flushTimer) this.flush(link);
	}

	flush(link) {
		link.flushTimer = null;
		while (link.queue.length) {
			if (this.links.get(link.peerId) !== link) return;
			if (this.room.controlBuffered(link.peerId) > HIGH_WATER) {
				link.flushTimer = setTimeout(() => this.flush(link), PACE_MS);
				return;
			}
			if (!this.room.send(CH.DOC, link.queue.shift(), link.peerId)) {
				// The link is going down; the next link up starts over with step 1.
				link.queue = [];
				return;
			}
		}
	}

	// --- receiving ---

	receive(msg, member) {
		const link = this.links.get(member.peerId) ?? (this.room.member(member.peerId) ? this.linkUp(member) : null);
		if (!link) return;
		if (msg.type === 'msg') {
			if (typeof msg.data === 'string') this.handle(link, msg.data);
			return;
		}
		if (msg.type !== 'part') return;
		const { id, part, parts, data } = msg;
		if (!Number.isInteger(parts) || parts < 2 || parts > MAX_PARTS || !Number.isInteger(part) || part < 0 || part >= parts || typeof data !== 'string') return;
		if (part === 0) link.incoming = { id, parts, chunks: [] };
		const incoming = link.incoming;
		// Parts of one message arrive in order on the reliable channel; anything else is a leftover.
		if (!incoming || incoming.id !== id || incoming.parts !== parts || incoming.chunks.length !== part) {
			link.incoming = null;
			return;
		}
		incoming.chunks.push(data);
		if (incoming.chunks.length === parts) {
			link.incoming = null;
			this.handle(link, incoming.chunks.join(''));
		}
	}

	handle(link, data) {
		const { encoding, decoding, syncProtocol, awarenessProtocol } = this.lib;
		try {
			const decoder = decoding.createDecoder(fromBase64url(data));
			const kind = decoding.readVarUint(decoder);
			if (kind === MSG_SYNC) {
				const reply = encoding.createEncoder();
				encoding.writeVarUint(reply, MSG_SYNC);
				const type = syncProtocol.readSyncMessage(decoder, reply, this.doc, link);
				if (encoding.length(reply) > 1) this.enqueue(link, encoding.toUint8Array(reply)); // step 1 is answered with step 2
				if (type === syncProtocol.messageYjsSyncStep2) {
					link.synced = true;
					if (!this.synced) {
						this.synced = true;
						this.emit('synced');
					}
				}
			} else if (kind === MSG_AWARENESS) {
				awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), link);
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
