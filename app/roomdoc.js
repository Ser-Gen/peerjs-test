import { DocProvider } from './docsync.js';
import { Emitter } from './emitter.js';
import { CH } from './protocol.js';
import { indexedDBUsable, sleep } from './util.js';

const STORAGE_WAIT = 4000; // blocked IndexedDB never answers; sync with the others anyway
const MAX_QUEUED = 5000; // messages kept while vendor/yjs.js loads

export const roomDocName = roomId => `peerkit.room:${roomId}`;

/**
 * The room's own Y.Doc, for what belongs to the room rather than to one document: the chat and its files
 * (app/tools/chat/timeline.js). It is kept in IndexedDB as `peerkit.room:<room ID>` and synced with every member
 * over ch 'room', the way the editor syncs its documents. It needs only vendor/yjs.js, not the editor bundle.
 * Events: 'synced' after the first sync with a member.
 */
export class RoomDoc extends Emitter {
	constructor(room, roomId) {
		super();
		this.room = room;
		this.roomId = roomId;
		this.lib = this.doc = this.persistence = this.provider = null;
		this.loading = null;
		this.destroyed = false;
		this.queued = [];
		// Members start syncing as soon as a link is up: keep what arrives before the bundle does.
		this.offEarly = room.on(`msg:${CH.ROOM}`, (msg, member) => {
			if (this.queued.length < MAX_QUEUED) this.queued.push([msg, member]);
		});
	}

	get synced() {
		return Boolean(this.provider?.synced);
	}

	load() {
		this.loading ??= this.open().catch(err => {
			this.loading = null;
			throw err;
		});
		return this.loading;
	}

	async open() {
		const lib = await import('../vendor/yjs.js');
		if (this.destroyed) return;
		const doc = new lib.Y.Doc();
		let persistence = null;
		if (await indexedDBUsable(STORAGE_WAIT)) {
			persistence = new lib.IndexeddbPersistence(roomDocName(this.roomId), doc);
			await Promise.race([persistence.whenSynced, sleep(STORAGE_WAIT)]);
		} else {
			console.warn('[peerkit] IndexedDB is not available: the chat is not saved on this device');
		}
		if (this.destroyed) {
			persistence?.destroy();
			doc.destroy();
			return;
		}
		this.lib = lib;
		this.doc = doc;
		this.persistence = persistence;
		this.provider = new DocProvider({ lib, room: this.room, doc, channel: CH.ROOM });
		this.provider.on('synced', () => this.emit('synced'));
		this.offEarly();
		for (const [msg, member] of this.queued.splice(0)) this.provider.receive(msg, member);
	}

	/** A change that came from another member, not from this device or its storage. */
	isRemote(origin) {
		return Boolean(this.provider) && origin?.provider === this.provider;
	}

	/** The member a remote change came through. */
	memberOf(origin) {
		return this.isRemote(origin) ? this.room.member(origin.peerId) : null;
	}

	destroy() {
		this.destroyed = true;
		this.offEarly();
		this.provider?.destroy();
		this.persistence?.destroy();
		this.doc?.destroy();
	}
}
