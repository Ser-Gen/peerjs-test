import { DocProvider } from './docsync.js';
import { Emitter } from './emitter.js';
import { CH } from './protocol.js';
import { indexedDBUsable, sleep } from './util.js';

const STORAGE_WAIT = 4000; // blocked IndexedDB never answers; sync with the others anyway
const MAX_QUEUED = 5000; // messages kept while vendor/yjs.js loads

export const roomDocName = roomId => `peerkit.room:${roomId}`;
export const boardDocName = roomId => `peerkit.board:${roomId}`;

/**
 * A Y.Doc that belongs to the room, kept in IndexedDB and synced with every member over one channel, the way the
 * editor syncs its documents. It needs only vendor/yjs.js, not the editor bundle. By default it is the room's
 * own document: the chat and its files (app/tools/chat/timeline.js), `peerkit.room:<room ID>` on ch 'room'.
 * The whiteboard has one of its own (`peerkit.board:<room ID>` on ch 'board', with awareness for the pens in
 * progress), so its images don't hold up the chat history a newcomer waits for.
 * Events: 'loaded' once it can be used, 'synced' after the first sync with a member.
 */
export class RoomDoc extends Emitter {
	/**
	 * @param {object} room
	 * @param {string} roomId
	 * @param {object} [options]
	 * @param {string} [options.name] the IndexedDB database
	 * @param {string} [options.channel]
	 * @param {boolean} [options.awareness] keep an Awareness (who is where) next to the document
	 * @param {boolean} [options.loadOnMessage] load when a member starts syncing, even if nothing here asked yet
	 * @param {string} [options.about] what it holds, for the warning when it can't be saved
	 */
	constructor(room, roomId, { name = roomDocName(roomId), channel = CH.ROOM, awareness = false, loadOnMessage = false, about = 'the chat' } = {}) {
		super();
		this.room = room;
		this.roomId = roomId;
		this.options = { name, channel, awareness, about };
		this.lib = this.doc = this.awareness = this.persistence = this.provider = null;
		this.loading = null;
		this.destroyed = false;
		this.queued = [];
		// Members start syncing as soon as a link is up: keep what arrives before the bundle does.
		this.offEarly = room.on(`msg:${channel}`, (msg, member) => {
			if (this.queued.length < MAX_QUEUED) this.queued.push([msg, member]);
			if (loadOnMessage) this.load().catch(() => {}); // whoever uses it shows the error when it asks
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
		const { name, channel, awareness, about } = this.options;
		const doc = new lib.Y.Doc();
		let persistence = null;
		if (await indexedDBUsable(STORAGE_WAIT)) {
			persistence = new lib.IndexeddbPersistence(name, doc);
			await Promise.race([persistence.whenSynced, sleep(STORAGE_WAIT)]);
		} else {
			console.warn(`[peerkit] IndexedDB is not available: ${about} is not saved on this device`);
		}
		if (this.destroyed) {
			persistence?.destroy();
			doc.destroy();
			return;
		}
		this.lib = lib;
		this.doc = doc;
		this.persistence = persistence;
		this.awareness = awareness ? new lib.awarenessProtocol.Awareness(doc) : null;
		this.provider = new DocProvider({ lib, room: this.room, doc, awareness: this.awareness, channel });
		this.provider.on('synced', () => this.emit('synced'));
		this.offEarly();
		for (const [msg, member] of this.queued.splice(0)) this.provider.receive(msg, member);
		this.emit('loaded');
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
		this.awareness?.destroy();
		this.persistence?.destroy();
		this.doc?.destroy();
	}
}
