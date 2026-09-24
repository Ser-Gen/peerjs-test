/* global Peer */
import { sameText } from './crypto.js';
import { cleanName, device } from './device.js';
import { Emitter } from './emitter.js';
import { CH, LABEL, PROTOCOL_VERSION } from './protocol.js';
import { roomIds, roomProof } from './rooms.js';
import { detectRoute, parseGuestTurn } from './turn.js';
import { randomId, randomInt, sleep } from './util.js';

const PING_INTERVAL = 2000;
const LOST_AFTER = 15000;
const HEALTH_TIMEOUT = 4000; // after the page wakes up, a ping must be answered this fast
const CONNECT_TIMEOUT = 20000;
const WELCOME_LINGER = 3000; // lets 'welcome' leave before the anchor closes the entry connection
const CHECK_EVERY = 30000; // how often a member makes sure it is linked to whoever holds the anchor
const CLAIM_JITTER = 3000; // members wait a random part of this before claiming a free anchor, so they rarely collide
const CLAIM_RETRY = 1500;
const ANCHOR_GONE_CHECK = 500; // the claim that may follow waits its own random delay
const LOOK_AGAIN = 3000; // while joining, after an entry attempt that got no answer
const RETRY_MIN = 1000; // backoff: 1, 2, 4… s
const RETRY_MAX = 15000;
const REDIAL_ATTEMPTS = 6;
const REJECT_LINGER = 1000;
const BYE_GRACE = 300; // lets 'bye' leave before the connections close
const ROUTE_EVERY = 10000;
const ALIVE = 5000; // a link heard from this recently isn't replaced by a second one from the same member
const MEET_DELAY = 3000; // after the last change in the members' links: a newcomer's own dials get this long to arrive
const MAX_GONE = 200;
const MAX_EARLY = 1000; // tool messages kept between authentication and the link being up
export const MAX_MEMBERS = 8;

// Backpressure for the binary channel: pause above HIGH, resume below LOW.
const HIGH_WATER = 2 * 1024 * 1024;
const LOW_WATER = 512 * 1024;
const DEFAULT_MESSAGE_SIZE = 64 * 1024;

// Losing the signaling server doesn't break established links.
const SIGNALING_ERRORS = new Set(['disconnected', 'network', 'server-error', 'socket-error', 'socket-closed']);
const REJECTIONS = new Set(['version', 'denied', 'duplicate', 'full']);
// Link endings after which nobody dials again.
const FINAL_REASONS = new Set(['bye', 'replaced', 'peer-unavailable', 'version', 'denied', 'duplicate', 'full', 'self', 'halt']);
// Link endings after which that peer ID isn't dialed because others still list it: it left, or can't link with us.
const GONE_REASONS = new Set(['bye', 'version', 'denied']);

export const COLORS = ['#e8590c', '#0c8599', '#7048e8', '#2f9e44', '#d6336c', '#1971c2', '#c08000', '#5c7cfa'];

export const memberColor = deviceId => COLORS[parseInt(String(deviceId).slice(0, 8), 16) % COLORS.length || 0];

const ERRORS = {
	'browser-incompatible': ['Browser not supported', 'This browser does not support WebRTC.'],
	'invalid-code': ['Invalid room code', 'A room code is 4 words, like amber-otter-quiet-lamp.'],
	'legacy-link': ['Link from an older version', 'PeerKit now uses rooms instead of pairing. Ask for a new room link or the room’s 4-word code.'],
	'invalid-key': ['Server rejected the key', 'The signaling server did not accept the API key.'],
	network: ['Server unreachable', 'Could not reach the signaling server. Check the internet connection and the server settings.'],
	'server-error': ['Server error', 'The signaling server did not respond as expected. Check the server settings or try again in a moment.'],
	'bad-link': ['Invalid link', 'The server settings in this link are damaged. Ask for a new link or scan the QR code again.'],
	'socket-error': ['Server connection failed', 'The connection to the signaling server failed.'],
	'socket-closed': ['Server connection closed', 'The signaling server closed the connection.'],
	disconnected: ['Server connection lost', 'Lost the connection to the signaling server.'],
	'ssl-unavailable': ['HTTPS not available', 'The signaling server does not support secure connections.'],
	'not-found': ['Nobody is in this room', 'No device has this room open right now. Check the code, or wait here until someone opens it. A code only works on the same server.'],
	denied: ['Could not join', 'The room did not accept this device. Check the code.'],
	full: ['Room is full', `A room holds up to ${MAX_MEMBERS} devices.`],
	version: ['Version mismatch', 'The devices in this room run a different app version. Reload the pages.'],
	webrtc: ['Direct connection failed', 'The devices could not open a direct connection.'],
	timeout: ['Connection timed out', 'The devices could not reach each other. A strict network (NAT or firewall) may be blocking direct connections.'],
	'other-tab': ['Open in another tab', 'PeerKit already has a room open in another tab or window.'],
	'moved-tab': ['Moved to another tab', 'The room was opened in another tab or window.'],
};

export function describeError(code) {
	const [title, text] = ERRORS[code] ?? ['Something went wrong', code ? `Error: ${code}` : 'Unknown error.'];
	return { title, text };
}

const cleanId = id => (typeof id === 'string' && /^[0-9a-f]{8,64}$/.test(id) ? id : null);
const cleanPeerId = id => (typeof id === 'string' && /^pk-m-[0-9a-f]{24}$/.test(id) ? id : null);

function fingerprint(sdp) {
	const match = /^a=fingerprint:(\S+) ([0-9a-f:]+)\s*$/im.exec(sdp ?? '');
	return match ? `${match[1].toLowerCase()} ${match[2].toUpperCase()}` : '';
}

function closeConn(conn) {
	try {
		conn?.close();
	} catch {
		// already closed
	}
}

function drain(dc) {
	return new Promise(resolve => {
		const done = () => {
			clearInterval(poll);
			dc.removeEventListener('bufferedamountlow', done);
			resolve();
		};
		// 'bufferedamountlow' is the fast path; polling covers a closed channel or a missed event.
		const poll = setInterval(() => {
			if (dc.readyState !== 'open' || dc.bufferedAmount <= LOW_WATER) done();
		}, 250);
		dc.addEventListener('bufferedamountlow', done);
	});
}

/**
 * One connection pair with another member (ctl + file), or an entry connection to or from the anchor.
 * States: connecting → authed (handshake done) → up (file connection open) → closed. A Link is used once.
 */
class Link {
	constructor(room, { peerId, localId, dialer, entry = false }) {
		this.room = room;
		this.peerId = peerId; // the other side's peer ID
		this.localId = localId; // ours on this connection: the member peer, or the anchor peer
		this.dialer = dialer;
		this.entry = entry;
		this.state = 'connecting';
		this.reason = null;
		this.ctl = null;
		this.file = null;
		this.nonce = randomId(16);
		this.remoteNonce = null;
		this.remote = null; // { name, deviceId } from its hello
		this.member = null; // { peerId, deviceId, name, color, rtt, route, anchor } once authenticated
		this.remotePeers = new Set(); // its own direct links
		this.early = [];
		this.startedAt = Date.now();
		this.lastSeen = Date.now();
		this.routeAt = 0;
		this.pingTimer = null;
		this.timer = setTimeout(() => this.close('timeout'), CONNECT_TIMEOUT);
	}

	dial(peer) {
		const ctl = peer.connect(this.peerId, { label: this.entry ? LABEL.ENTRY : LABEL.CTL, serialization: 'json', reliable: true });
		if (!ctl) return this.close('disconnected'); // peerjs returns nothing while the server is unreachable
		this.attachCtl(ctl);
		ctl.on('open', () => this.send(CH.SYS, { type: 'hello', ...this.identity() }));
	}

	accept(conn) {
		this.attachCtl(conn);
	}

	identity() {
		const { identity } = this.room;
		return { v: PROTOCOL_VERSION, nonce: this.nonce, name: identity.name, deviceId: identity.id };
	}

	attachCtl(conn) {
		this.ctl = conn;
		conn.on('data', msg => {
			if (this.state === 'closed') return;
			this.lastSeen = Date.now();
			this.onData(msg);
		});
		conn.on('close', () => this.close(this.state === 'connecting' ? 'webrtc' : 'lost'));
		conn.on('error', err => {
			console.warn('[peerkit] control connection error', err);
			this.close(this.state === 'connecting' ? 'webrtc' : 'lost');
		});
	}

	attachFile(conn) {
		this.file = conn;
		const onOpen = () => {
			if (this.state !== 'authed') return;
			conn.dataChannel.bufferedAmountLowThreshold = LOW_WATER;
			this.up();
		};
		if (conn.open) onOpen();
		else conn.on('open', onOpen);
		conn.on('data', data => {
			if (this.state === 'up') this.room.emit('binary', data, this.member);
		});
		conn.on('close', () => this.close('lost'));
		conn.on('error', err => {
			console.warn('[peerkit] file connection error', err);
			this.close('lost');
		});
	}

	dialFile(peer) {
		const file = peer?.connect(this.peerId, { label: LABEL.FILE, serialization: 'raw', reliable: true });
		if (file) this.attachFile(file);
		else this.close('disconnected');
	}

	onData(msg) {
		if (!msg || typeof msg !== 'object' || typeof msg.ch !== 'string') return;
		if (msg.ch === CH.SYS && msg.type === 'reject') {
			this.close(REJECTIONS.has(msg.reason) ? msg.reason : 'denied');
			return;
		}
		if (this.state === 'connecting') {
			if (msg.ch === CH.SYS) this.handshake(msg);
			return;
		}
		if (this.state === 'authed' && msg.ch !== CH.SYS && !this.entry) {
			// The other side may be up a moment before us; keep its first tool messages for when we are.
			if (this.early.length < MAX_EARLY) this.early.push(msg);
			return;
		}
		this.room._onLinkMessage(this, msg);
	}

	handshake(msg) {
		if (msg.type === 'hello') {
			if (this.remoteNonce) return;
			if (msg.v !== PROTOCOL_VERSION) return this.reject('version');
			const deviceId = cleanId(msg.deviceId);
			if (typeof msg.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(msg.nonce) || !deviceId) return this.reject('denied');
			this.remoteNonce = msg.nonce;
			this.remote = { name: cleanName(msg.name) || 'Device', deviceId };
			if (!this.dialer) {
				this.send(CH.SYS, { type: 'hello', ...this.identity(), proof: this.proof('answer') });
				return;
			}
			if (!sameText(msg.proof, this.proof('answer'))) return this.reject('denied');
			this.send(CH.SYS, { type: 'proof', proof: this.proof('dial') });
			this.authed();
			return;
		}
		if (msg.type === 'proof' && !this.dialer && this.remoteNonce) {
			if (!sameText(msg.proof, this.proof('dial'))) return this.reject('denied');
			this.authed();
		}
	}

	/** HMAC with the room key over everything that identifies this connection, including both DTLS certificates. */
	proof(role) {
		const pc = this.ctl?.peerConnection;
		const local = fingerprint(pc?.localDescription?.sdp);
		const remote = fingerprint(pc?.remoteDescription?.sdp);
		const [dialerId, answererId] = this.dialer ? [this.localId, this.peerId] : [this.peerId, this.localId];
		const [dialerNonce, answererNonce] = this.dialer ? [this.nonce, this.remoteNonce] : [this.remoteNonce, this.nonce];
		const [dialerCert, answererCert] = this.dialer ? [local, remote] : [remote, local];
		const label = this.entry ? LABEL.ENTRY : LABEL.CTL;
		return roomProof(this.room.ids.key, [role, PROTOCOL_VERSION, label, dialerNonce, answererNonce, dialerId, answererId, dialerCert, answererCert]);
	}

	authed() {
		this.state = 'authed';
		const { deviceId, name } = this.remote;
		this.member = { peerId: this.peerId, deviceId, name, color: memberColor(deviceId), rtt: null, route: null, anchor: false };
		this.room._onLinkAuthed(this);
	}

	up() {
		clearTimeout(this.timer);
		this.state = 'up';
		this.lastSeen = Date.now();
		this.pingTimer = setInterval(() => {
			if (Date.now() - this.lastSeen > LOST_AFTER) this.close('lost');
			else this.ping();
		}, PING_INTERVAL);
		for (const pc of new Set([this.ctl?.peerConnection, this.file?.peerConnection])) {
			pc?.addEventListener('iceconnectionstatechange', () => {
				if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') this.close('lost');
			});
		}
		this.room._onLinkUp(this);
		for (const msg of this.early.splice(0)) {
			if (this.state === 'up') this.room._onLinkMessage(this, msg);
		}
		this.ping();
	}

	ping() {
		this.send(CH.SYS, { type: 'ping', t: performance.now() });
	}

	send(ch, msg) {
		const conn = this.ctl;
		if (!conn?.open || this.state === 'closed') return false;
		try {
			conn.send({ ...msg, ch });
			return true;
		} catch (err) {
			console.warn('[peerkit] send failed', err);
			return false;
		}
	}

	reject(reason) {
		this.send(CH.SYS, { type: 'reject', reason });
		this.close(reason, { linger: REJECT_LINGER });
	}

	close(reason = 'lost', { linger = 0 } = {}) {
		if (this.state === 'closed') return;
		const was = this.state;
		this.state = 'closed';
		this.reason = reason;
		clearTimeout(this.timer);
		clearInterval(this.pingTimer);
		this.early = [];
		const conns = [this.ctl, this.file];
		if (linger) setTimeout(() => conns.forEach(closeConn), linger);
		else conns.forEach(closeConn);
		this.room._onLinkClosed(this, was);
	}
}

/**
 * A room: this device's member peer plus a link to every other member (full mesh).
 *
 * States: idle → starting (registering with the server) → joining (looking for the room) → open, or failed (error).
 * `open` stays while the device is in the room, alone or not; members come and go as events.
 *
 * The anchor is whoever holds the room's well-known peer ID. Newcomers connect to it, get the member list and
 * dial everyone. When it leaves, any member claims the ID; the server lets only one succeed. A member that others
 * are linked to and this device isn't (two newcomers at once) is dialed by the lower peer ID of the two.
 *
 * Events: 'state' (state, error), 'members' (list or details changed), 'link-up' / 'link-down' (member, reason),
 * `msg:<ch>` (message, member), 'binary' (ArrayBuffer, member), 'call' (MediaConnection, member),
 * 'rtt' (member), 'links' (member whose own direct links changed), 'turn' (credentials adopted from a member).
 */
export class Room extends Emitter {
	constructor({ code, peerOptions = {}, ice, known = true, identity = device }) {
		super();
		this.code = code;
		this.ids = roomIds(code);
		this.peerOptions = peerOptions;
		this.ice = ice;
		// This device made the room or has been in it: it tries to hold the anchor first, which is quick either way.
		// Otherwise it only looks for the room, and an empty room is "not found".
		this.known = known;
		this.identity = identity; // { id, name } of this device; `device` except in tests
		this.state = 'idle';
		this.error = null;
		this.self = { peerId: null, deviceId: identity.id, name: identity.name, color: memberColor(identity.id) };
		this.peer = null;
		this.anchorPeer = null;
		this.isAnchor = false;
		this.links = new Map(); // peerId → Link with that member (dialing, authed or up)
		this.incoming = new Set(); // links dialed by others that aren't authenticated yet
		this.entries = new Set(); // entry links: ours to the anchor, or newcomers' to our anchor peer
		this.redials = new Map(); // peerId → { attempts, timer }
		this.gone = new Set(); // peer IDs that left or can't link with us, oldest first
		this.opened = false; // the member peer registered at least once
		this.signalingLost = false;
		this.entryFailures = 0; // entry attempts that got no answer since the last success
		this.destroyed = false;
		this.halting = false;
		this._brokerTimer = null;
		this._brokerAttempts = 0;
		this._anchorTimer = null;
		this._anchorAttempts = 0;
		this._checkTimer = null;
		this._claimTimer = null;
		this._meetTimer = null;
		this._offDevice = identity.on?.('change', () => {
			this.self.name = identity.name;
			this.send(CH.SYS, { type: 'name', name: identity.name });
			this.emit('members');
		}) ?? (() => {});
	}

	start() {
		this._createPeer();
	}

	/** Start over after a failure. */
	retry() {
		this._halt();
		this.error = null;
		this.entryFailures = 0;
		this._createPeer();
	}

	/** Nobody was in the room: open it anyway and wait for the others. */
	waitHere() {
		this.known = true;
		this.retry();
	}

	/** Leave everything and stay failed until `retry()`, e.g. when another tab took over. */
	stop(code) {
		this._halt();
		this._setState('failed', code);
	}

	fail(code) {
		this.stop(code);
	}

	destroy() {
		this.destroyed = true;
		this._offDevice();
		this._halt();
	}

	/** Leave on purpose: the others don't wait for this device to come back. */
	async leave() {
		this.send(CH.SYS, { type: 'bye' });
		await sleep(BYE_GRACE);
		this.destroy();
	}

	/** Call when the page becomes visible or the network returns: check now instead of waiting for timers. */
	checkHealth() {
		if (this.destroyed) return;
		if (this.state === 'failed') {
			if (SIGNALING_ERRORS.has(this.error)) this.retry();
			return;
		}
		const peer = this.peer;
		if (this.opened && peer && !peer.destroyed && peer.disconnected) {
			this._clearBroker();
			this._brokerAttempts = 0;
			this._reviveSignaling();
		}
		if (this.anchorPeer && !this.anchorPeer.destroyed && this.anchorPeer.disconnected) {
			clearTimeout(this._anchorTimer);
			this._anchorTimer = null;
			this.anchorPeer.reconnect();
		}
		for (const link of this._upLinks()) {
			const asked = Date.now();
			link.ping();
			setTimeout(() => {
				if (link.state === 'up' && link.lastSeen < asked) link.close('lost');
			}, HEALTH_TIMEOUT);
		}
		if (this.state === 'open') this._scheduleCheck(HEALTH_TIMEOUT + 500);
	}

	// --- for tools ---

	/** Members linked right now (not this device). */
	get members() {
		return this._upLinks().map(link => link.member);
	}

	member(peerId) {
		const link = this.links.get(peerId);
		return link?.state === 'up' ? link.member : null;
	}

	/** Members being connected to (dialed or authenticating). */
	get connecting() {
		return [...this.links.values()].filter(link => link.state !== 'up').length;
	}

	/** Send to one member (`to` = peer ID) or to all. Returns how many got it. */
	send(ch, msg, to = null) {
		let sent = 0;
		for (const link of this._upLinks(to)) if (link.send(ch, msg)) sent++;
		return sent;
	}

	/** Send one binary message to a member, waiting first if its channel buffer is full. Rejects if the link drops. */
	async sendBinary(to, data) {
		const link = this._upLinks(to)[0];
		const conn = link?.file;
		if (!conn?.open) throw new Error('Not connected');
		if (conn.dataChannel.bufferedAmount > HIGH_WATER) await drain(conn.dataChannel);
		if (link.state !== 'up' || !conn.open) throw new Error('Not connected');
		conn.send(data);
	}

	bufferedAmount(to) {
		return this.links.get(to)?.file?.dataChannel?.bufferedAmount ?? 0;
	}

	/** Bytes waiting on a member's control connection; tools that send a lot through it pace themselves. */
	controlBuffered(to) {
		return this.links.get(to)?.ctl?.dataChannel?.bufferedAmount ?? 0;
	}

	maxMessageSize(to) {
		const max = this.links.get(to)?.file?.peerConnection?.sctp?.maxMessageSize;
		return Math.min(DEFAULT_MESSAGE_SIZE, max > 0 ? max : DEFAULT_MESSAGE_SIZE);
	}

	/** Send a media stream to a member (peerjs MediaConnection). Null when that isn't possible now. */
	call(to, stream, metadata, options = {}) {
		if (!this.member(to) || !this.peer?.open) return null;
		return this.peer.call(to, stream, { ...options, metadata }) ?? null;
	}

	/** Whether two members (this device included) have a direct link, as far as this device knows. */
	isLinked(a, b) {
		const self = this.self.peerId;
		if (a === self) return Boolean(this.member(b));
		if (b === self) return Boolean(this.member(a));
		const link = this.links.get(a);
		return link?.state === 'up' && link.remotePeers.has(b);
	}

	/** Send fresh TURN credentials to everyone, e.g. after they were renewed. */
	shareTurn() {
		const turn = this.ice.forRoom;
		if (turn) this.send(CH.SYS, { type: 'turn', turn });
	}

	// --- member peer ---

	_createPeer() {
		if (!this.opened) this._setState('starting');
		if (typeof Peer !== 'function') {
			this._setState('failed', 'browser-incompatible');
			return;
		}
		const peer = (this.peer = new Peer(`pk-m-${randomId(12)}`, { debug: 1, ...this.peerOptions }));
		peer.on('open', id => {
			if (peer === this.peer) this._onOpen(id);
		});
		peer.on('connection', conn => {
			if (peer === this.peer) this._onConnection(conn);
			else closeConn(conn);
		});
		peer.on('call', call => {
			const link = peer === this.peer ? this.links.get(call.peer) : null;
			// A call can arrive just before the file connection is up.
			if (link && (link.state === 'up' || link.state === 'authed')) this.emit('call', call, link.member);
			else call.close();
		});
		peer.on('disconnected', () => {
			if (peer !== this.peer || !this.opened || this.state === 'failed') return;
			this.signalingLost = true;
			this._changed();
			this._recoverSignaling();
		});
		peer.on('error', err => {
			if (peer === this.peer && !this.destroyed) this._onPeerError(err);
		});
	}

	_onOpen(id) {
		// Also fires again after every reconnect to the server, with the same ID.
		const first = !this.opened || id !== this.self.peerId;
		this.opened = true;
		this._brokerAttempts = 0;
		this.self.peerId = id;
		if (this.signalingLost) {
			this.signalingLost = false;
			this._changed();
		}
		if (this.state === 'starting') {
			this._setState('joining');
			if (this.known) this._claimAnchor(0);
			else this._findRoom();
		} else if (first || this.state === 'open') {
			this._scheduleCheck(500);
		}
	}

	_onPeerError(err) {
		const type = err?.type ?? 'unknown';
		if (type === 'peer-unavailable') {
			// peerjs names the missing peer only in the message.
			const id = /Could not connect to peer (\S+)/.exec(err.message ?? '')?.[1];
			if (id === this.ids.anchorId) {
				for (const entry of this.entries) if (entry.dialer) entry.close('peer-unavailable');
			} else {
				this.links.get(id)?.close('peer-unavailable');
			}
			return;
		}
		console.warn('[peerkit] peer error:', type, err);
		if (type === 'webrtc' || this.state === 'failed') return; // a broken connection closes its own link
		if (type === 'unavailable-id' && !this.opened) {
			// A random member ID that happens to be taken.
			this._dropPeer();
			this._createPeer();
			return;
		}
		if (this.opened && SIGNALING_ERRORS.has(type)) {
			this.signalingLost = true;
			this._changed();
			this._recoverSignaling();
			return;
		}
		this.stop(type);
	}

	_recoverSignaling() {
		if (this._brokerTimer || this.destroyed) return;
		const wait = Math.min(RETRY_MAX, RETRY_MIN * 2 ** this._brokerAttempts++);
		this._brokerTimer = setTimeout(() => {
			this._brokerTimer = null;
			if (!this.destroyed && this.state !== 'failed') this._reviveSignaling();
		}, wait);
	}

	_reviveSignaling() {
		const peer = this.peer;
		// peerjs destroys a peer whose first registration failed and only disconnects one that had an ID.
		if (!peer || peer.destroyed) this._createPeer();
		else if (peer.disconnected) peer.reconnect();
	}

	_clearBroker() {
		clearTimeout(this._brokerTimer);
		this._brokerTimer = null;
	}

	_dropPeer() {
		const peer = this.peer;
		this.peer = null; // first, so its close events are ignored
		try {
			peer?.destroy();
		} catch {
			// already gone
		}
	}

	_onConnection(conn) {
		if (conn.label === LABEL.FILE) {
			const link = this.links.get(conn.peer);
			if (link && !link.dialer && link.state === 'authed' && !link.file) link.attachFile(conn);
			else closeConn(conn);
			return;
		}
		if (conn.label !== LABEL.CTL || !cleanPeerId(conn.peer)) {
			closeConn(conn);
			return;
		}
		// Not trusted until the handshake; only then may it replace a link we already have.
		const link = new Link(this, { peerId: conn.peer, localId: this.self.peerId, dialer: false });
		this.incoming.add(link);
		link.accept(conn);
	}

	// --- finding the room and the anchor ---

	_findRoom() {
		if (this.isAnchor || this.anchorPeer || this.destroyed || !this.peer?.open) return;
		if ([...this.entries].some(entry => entry.dialer)) return;
		const entry = new Link(this, { peerId: this.ids.anchorId, localId: this.self.peerId, dialer: true, entry: true });
		this.entries.add(entry);
		entry.dial(this.peer);
		this._changed();
	}

	_onEntryClosed(reason) {
		if (this.destroyed || this.halting || this.state === 'failed' || this.isAnchor) return;
		switch (reason) {
			case 'welcomed':
				return;
			case 'peer-unavailable':
				// Nobody holds the anchor.
				if (this.state === 'joining' && !this.known) return this.stop('not-found');
				return this._claimAnchor(this.links.size ? randomInt(CLAIM_JITTER) : 0);
			case 'version':
			case 'full':
			case 'denied':
				if (this.state === 'joining') return this.stop(reason);
				return this._scheduleCheck();
			default:
				// No answer: an anchor that dropped off the network holds its ID until the server notices, and
				// a strict network may block the connection. Keep looking.
				this.entryFailures++;
				this._changed();
				return this._scheduleCheck(this.state === 'joining' ? LOOK_AGAIN : CHECK_EVERY);
		}
	}

	_onWelcome(entry, msg) {
		entry.close('welcomed');
		this.entryFailures = 0;
		const turn = parseGuestTurn(msg.turn);
		if (turn) this._adoptTurn(turn);
		const list = Array.isArray(msg.members) ? msg.members.slice(0, MAX_MEMBERS * 2) : [];
		for (const raw of list) {
			const peerId = cleanPeerId(raw?.peerId);
			const deviceId = cleanId(raw?.deviceId);
			if (!peerId || !deviceId || peerId === this.self.peerId || deviceId === this.identity.id || this.links.has(peerId)) continue;
			this._dial(peerId);
		}
		if (this.state === 'joining') this._setState('open');
		else this._changed();
	}

	_claimAnchor(delay) {
		clearTimeout(this._claimTimer);
		this._claimTimer = setTimeout(() => {
			this._claimTimer = null;
			if (this.destroyed || this.state === 'failed' || this.isAnchor || this.anchorPeer) return;
			if (this.members.some(member => member.anchor)) return; // someone else took it meanwhile
			this._createAnchorPeer();
		}, delay);
	}

	_createAnchorPeer() {
		let registered = false;
		const peer = (this.anchorPeer = new Peer(this.ids.anchorId, { debug: 1, ...this.peerOptions }));
		peer.on('open', () => {
			if (peer !== this.anchorPeer) return;
			registered = true;
			this._anchorAttempts = 0;
			if (!this.isAnchor) {
				this.isAnchor = true;
				this.entryFailures = 0;
				this.send(CH.SYS, { type: 'anchor', held: true });
			}
			if (this.state === 'joining') this._setState('open');
			else this._changed();
		});
		peer.on('connection', conn => {
			if (peer !== this.anchorPeer || conn.label !== LABEL.ENTRY || !cleanPeerId(conn.peer)) {
				closeConn(conn);
				return;
			}
			const entry = new Link(this, { peerId: conn.peer, localId: this.ids.anchorId, dialer: false, entry: true });
			this.entries.add(entry);
			entry.accept(conn);
		});
		peer.on('call', call => call.close());
		peer.on('disconnected', () => {
			if (peer === this.anchorPeer && registered) this._recoverAnchor();
		});
		peer.on('error', err => {
			if (peer !== this.anchorPeer || this.destroyed) return;
			const type = err?.type ?? 'unknown';
			if (type === 'peer-unavailable' || type === 'webrtc') return;
			if (type === 'unavailable-id') {
				// Another member got it first (or still holds it): find the room through them.
				this._dropAnchor();
				this._scheduleCheck(this.state === 'joining' ? 0 : CLAIM_RETRY);
				return;
			}
			if (registered && SIGNALING_ERRORS.has(type)) {
				this._recoverAnchor();
				return;
			}
			console.warn('[peerkit] anchor peer error:', type, err);
			this._dropAnchor();
			this._scheduleCheck(this.state === 'joining' ? LOOK_AGAIN : CHECK_EVERY);
		});
	}

	_recoverAnchor() {
		if (this._anchorTimer || this.destroyed) return;
		const wait = Math.min(RETRY_MAX, RETRY_MIN * 2 ** this._anchorAttempts++);
		this._anchorTimer = setTimeout(() => {
			this._anchorTimer = null;
			const peer = this.anchorPeer;
			if (!peer || this.destroyed) return;
			if (peer.destroyed) {
				this._dropAnchor();
				this._scheduleCheck(500);
			} else if (peer.disconnected) {
				peer.reconnect(); // fails with unavailable-id if another member took over meanwhile
			}
		}, wait);
	}

	_dropAnchor() {
		const peer = this.anchorPeer;
		this.anchorPeer = null;
		clearTimeout(this._anchorTimer);
		this._anchorTimer = null;
		try {
			peer?.destroy();
		} catch {
			// already gone
		}
		for (const entry of [...this.entries]) if (!entry.dialer) entry.close('halt');
		if (this.isAnchor) {
			this.isAnchor = false;
			this.send(CH.SYS, { type: 'anchor', held: false });
			this._changed();
		}
	}

	_scheduleCheck(delay = CHECK_EVERY) {
		if (this.destroyed) return;
		clearTimeout(this._checkTimer);
		this._checkTimer = setTimeout(() => this._check(), delay);
	}

	/** Make sure this device is linked to whoever holds the anchor, or holds it itself. */
	_check() {
		this._checkTimer = null;
		if (this.destroyed || this.state === 'failed') return;
		if (this.state === 'open') this._scheduleCheck();
		if (this.isAnchor || this.anchorPeer || !this.peer?.open) return;
		if (this.members.some(member => member.anchor)) return;
		this._findRoom();
	}

	// --- links ---

	_dial(peerId) {
		const link = new Link(this, { peerId, localId: this.self.peerId, dialer: true });
		this.links.set(peerId, link);
		link.dial(this.peer);
	}

	_upLinks(to = null) {
		if (to) {
			const link = this.links.get(to);
			return link?.state === 'up' ? [link] : [];
		}
		return [...this.links.values()].filter(link => link.state === 'up');
	}

	_onLinkAuthed(link) {
		if (link.remote.deviceId === this.identity.id) return link.reject('denied'); // this browser, e.g. a copied profile
		if (link.entry) {
			if (link.dialer) return; // waits for welcome
			const members = this.members;
			const known = members.some(member => member.deviceId === link.remote.deviceId);
			if (!known && members.length + 1 >= MAX_MEMBERS) return link.reject('full');
			const info = ({ peerId, name, deviceId }) => ({ peerId, name, deviceId });
			link.send(CH.SYS, { type: 'welcome', members: [info(this.self), ...members.map(info)], turn: this.ice.forRoom ?? undefined });
			link.close('welcomed', { linger: WELCOME_LINGER });
			return;
		}
		if (!link.dialer) {
			this.incoming.delete(link);
			const existing = this.links.get(link.peerId);
			if (existing && existing !== link) {
				// Both sides dialed, or the other side thinks the old link is dead. The lower peer ID's dial wins;
				// otherwise keep a link that is still alive.
				const alive = existing.state === 'up'
					? Date.now() - existing.lastSeen < ALIVE
					: existing.dialer && Date.now() - existing.startedAt < CONNECT_TIMEOUT;
				if (link.peerId > this.self.peerId && alive) return link.reject('duplicate');
				existing.close('replaced');
			}
			this.links.set(link.peerId, link);
		}
		// The same device with a new peer ID reloaded its page: the old link is stale.
		for (const other of [...this.links.values()]) {
			if (other === link || other.remote?.deviceId !== link.remote.deviceId) continue;
			other.close('replaced');
			if (other.peerId !== link.peerId) this._markGone(other.peerId);
		}
		if (link.dialer) link.dialFile(this.peer);
	}

	_onLinkUp(link) {
		const redial = this.redials.get(link.peerId);
		if (redial) {
			clearTimeout(redial.timer);
			this.redials.delete(link.peerId);
		}
		if (this.isAnchor) link.send(CH.SYS, { type: 'anchor', held: true });
		const turn = this.ice.forRoom;
		if (turn) link.send(CH.SYS, { type: 'turn', turn });
		this._shareLinks();
		this.emit('link-up', link.member);
		this.emit('members');
		this._detectRoute(link);
	}

	_onLinkClosed(link, was) {
		if (link.entry) {
			this.entries.delete(link);
			if (link.dialer) this._onEntryClosed(link.reason);
			return;
		}
		this.incoming.delete(link);
		if (this.links.get(link.peerId) === link) this.links.delete(link.peerId);
		if (GONE_REASONS.has(link.reason)) this._markGone(link.peerId);
		if (was === 'up') {
			this.emit('link-down', link.member, link.reason);
			this.emit('members');
			if (!this.halting) this._shareLinks();
		}
		if (this.destroyed || this.halting || this.state === 'failed' || FINAL_REASONS.has(link.reason)) {
			if (link.reason === 'peer-unavailable' || link.reason === 'bye') this._clearRedial(link.peerId);
		} else if (!this.links.has(link.peerId)) {
			// A member that dropped: the lower peer ID dials again, so both sides don't. A member from the
			// welcome list that we never reached: we keep trying for a while.
			if (was !== 'up' ? link.dialer : this.self.peerId < link.peerId) this._scheduleRedial(link.peerId);
		}
		if (was === 'up' && link.member.anchor && !this.halting) this._scheduleCheck(ANCHOR_GONE_CHECK);
	}

	_scheduleRedial(peerId) {
		const redial = this.redials.get(peerId) ?? { attempts: 0, timer: null };
		if (redial.attempts >= REDIAL_ATTEMPTS) {
			this.redials.delete(peerId);
			return;
		}
		clearTimeout(redial.timer);
		const delay = Math.min(RETRY_MAX, RETRY_MIN * 2 ** redial.attempts++);
		redial.timer = setTimeout(() => {
			if (this.destroyed || this.state === 'failed' || this.links.has(peerId)) return;
			if (this.peer?.open) this._dial(peerId);
			else this._scheduleRedial(peerId); // the server is unreachable: counts as an attempt
		}, delay);
		this.redials.set(peerId, redial);
	}

	_clearRedial(peerId) {
		clearTimeout(this.redials.get(peerId)?.timer);
		this.redials.delete(peerId);
	}

	_onLinkMessage(link, msg) {
		if (link.entry) {
			if (link.dialer && msg.ch === CH.SYS && msg.type === 'welcome') this._onWelcome(link, msg);
			return;
		}
		if (msg.ch !== CH.SYS) {
			if (link.state === 'up') this.emit(`msg:${msg.ch}`, msg, link.member);
			return;
		}
		const { member } = link;
		switch (msg.type) {
			case 'ping':
				link.send(CH.SYS, { type: 'pong', t: msg.t });
				break;
			case 'pong':
				if (typeof msg.t !== 'number') break;
				member.rtt = Math.max(0, Math.round(performance.now() - msg.t));
				this.emit('rtt', member);
				if (Date.now() - link.routeAt > ROUTE_EVERY) this._detectRoute(link);
				break;
			case 'anchor':
				member.anchor = msg.held === true;
				this.emit('members');
				if (!member.anchor) this._scheduleCheck(ANCHOR_GONE_CHECK);
				break;
			case 'links': {
				const peers = new Set(Array.isArray(msg.peers) ? msg.peers.map(cleanPeerId).filter(Boolean).slice(0, MAX_MEMBERS * 2) : []);
				const changed = peers.size !== link.remotePeers.size || [...peers].some(peer => !link.remotePeers.has(peer));
				link.remotePeers = peers;
				if (changed) {
					this.emit('links', member);
					this._scheduleMeet();
				}
				break;
			}
			case 'name':
				member.name = cleanName(msg.name) || member.name;
				this.emit('members');
				break;
			case 'turn': {
				const turn = parseGuestTurn(msg.turn);
				if (turn) this._adoptTurn(turn);
				break;
			}
			case 'bye':
				link.close('bye');
				break;
		}
	}

	_shareLinks() {
		this.send(CH.SYS, { type: 'links', peers: this._upLinks().map(link => link.peerId) });
	}

	_scheduleMeet() {
		if (this.destroyed) return;
		clearTimeout(this._meetTimer);
		this._meetTimer = setTimeout(() => this._meet(), MEET_DELAY);
	}

	/**
	 * Dial the members that others are linked to and this device isn't. Two newcomers welcomed at the same moment
	 * aren't on each other's list, so only the members' `links` tell them about each other. The lower peer ID
	 * dials, as for redials; a newcomer's own dials had MEET_DELAY to arrive, and one that did is in `incoming`.
	 */
	_meet() {
		this._meetTimer = null;
		if (this.destroyed || this.state !== 'open' || !this.peer?.open) return;
		const self = this.self.peerId;
		const answering = new Set([...this.incoming].map(link => link.peerId));
		for (const link of this._upLinks()) {
			for (const peerId of link.remotePeers) {
				if (peerId <= self || this.links.has(peerId) || answering.has(peerId) || this.redials.has(peerId) || this.gone.has(peerId)) continue;
				if (this.links.size >= MAX_MEMBERS - 1) return;
				this._dial(peerId);
			}
		}
	}

	_markGone(peerId) {
		this.gone.delete(peerId);
		this.gone.add(peerId);
		if (this.gone.size > MAX_GONE) this.gone.delete(this.gone.values().next().value);
	}

	_adoptTurn(turn) {
		if (this.ice.adopt(turn)) this.emit('turn', turn);
	}

	async _detectRoute(link) {
		link.routeAt = Date.now();
		const route = await detectRoute(link.ctl?.peerConnection);
		if (link.state !== 'up' || !route) return;
		const changed = route.relayed !== link.member.route?.relayed || route.protocol !== link.member.route?.protocol;
		link.member.route = route;
		if (changed) this.emit('members');
	}

	// --- teardown ---

	_halt() {
		this.halting = true;
		this._clearBroker();
		clearTimeout(this._checkTimer);
		clearTimeout(this._claimTimer);
		clearTimeout(this._meetTimer);
		this._checkTimer = this._claimTimer = this._meetTimer = null;
		for (const redial of this.redials.values()) clearTimeout(redial.timer);
		this.redials.clear();
		for (const link of [...this.links.values(), ...this.incoming, ...this.entries]) link.close('halt');
		this._dropAnchor();
		this._dropPeer();
		this.opened = false;
		this.signalingLost = false;
		this.halting = false;
	}

	_setState(state, error = null) {
		if (this.destroyed || (state === this.state && error === this.error)) return;
		const wasOpen = this.state === 'open';
		this.state = state;
		this.error = error;
		if (state === 'open' && !wasOpen) this._scheduleCheck();
		this.emit('state', state, error);
	}

	/** Re-render for details that aren't a state change. */
	_changed() {
		if (!this.destroyed) this.emit('state', this.state, this.error);
	}
}
