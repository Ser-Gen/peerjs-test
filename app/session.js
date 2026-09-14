/* global Peer */
import { cleanName, device } from './device.js';
import { Emitter } from './emitter.js';
import { CH, LABEL, PROTOCOL_VERSION, TOKEN_RE } from './protocol.js';
import { sleep } from './util.js';

const PING_INTERVAL = 2000;
const LOST_AFTER = 15000;
const HEALTH_TIMEOUT = 4000; // after the page wakes up, a ping must be answered this fast
const CONNECT_TIMEOUT = 20000;
const APPROVAL_TIMEOUT = 60000;
const RETRY_MIN = 1000; // backoff: 1, 2, 4… s
const RETRY_MAX = 15000;
const ID_RETRY = 3000;
const BYE_GRACE = 300; // lets 'bye' leave before the connection closes

// Backpressure for the binary channel: pause above HIGH, resume below LOW.
const HIGH_WATER = 2 * 1024 * 1024;
const LOW_WATER = 512 * 1024;
const DEFAULT_MESSAGE_SIZE = 64 * 1024;

// Losing the signaling server doesn't break an established P2P link.
const SIGNALING_ERRORS = new Set(['disconnected', 'network', 'server-error', 'socket-error', 'socket-closed']);
const REJECTIONS = new Set(['busy', 'version', 'denied', 'no-answer', 'ended']);

const ERRORS = {
	'browser-incompatible': ['Browser not supported', 'This browser does not support WebRTC.'],
	'invalid-id': ['Invalid link', 'The room code in this link is not valid.'],
	'invalid-key': ['Server rejected the key', 'The signaling server did not accept the API key.'],
	network: ['Server unreachable', 'Could not reach the signaling server. Check the internet connection and the server settings.'],
	'server-error': ['Server error', 'The signaling server did not respond as expected. Check the server settings or try again in a moment.'],
	'bad-link': ['Invalid link', 'The server settings in this link are damaged. Ask for a new link or scan the QR code again.'],
	'socket-error': ['Server connection failed', 'The connection to the signaling server failed.'],
	'socket-closed': ['Server connection closed', 'The signaling server closed the connection.'],
	disconnected: ['Server connection lost', 'Lost the connection to the signaling server.'],
	'ssl-unavailable': ['HTTPS not available', 'The signaling server does not support secure connections.'],
	'unavailable-id': ['ID already in use', 'This session ID is taken. Try again.'],
	'peer-unavailable': ['Host not found', 'Check the room code. The host page may be closed, or the host uses a different server.'],
	webrtc: ['Direct connection failed', 'The devices could not open a direct connection.'],
	timeout: ['Connection timed out', 'The devices could not reach each other. A strict network (NAT or firewall) may be blocking direct connections.'],
	lost: ['Connection lost', 'The other device stopped responding.'],
	busy: ['Host is busy', 'This host is already connected to another device.'],
	version: ['Version mismatch', 'The devices run different app versions. Reload both pages.'],
	denied: ['Not allowed', 'The host did not let this device join.'],
	'no-answer': ['No answer', 'Nobody confirmed this device on the host screen.'],
	ended: ['Session ended', 'The host ended the session.'],
	'other-tab': ['Open in another tab', 'PeerKit is already running this session in another tab or window.'],
	'moved-tab': ['Moved to another tab', 'This session was opened in another tab or window.'],
};

export function describeError(code) {
	const [title, text] = ERRORS[code] ?? ['Something went wrong', code ? `Error: ${code}` : 'Unknown error.'];
	return { title, text };
}

/**
 * One 1-to-1 session between a host (stable ID `peerId`, shows the code) and a guest (joins it).
 *
 * States: idle → starting → waiting (host) | connecting → [pending] (guest) → connected.
 * A host whose guest leaves goes back to waiting. A guest that was connected goes to
 * reconnecting and retries with backoff. failed carries an error code.
 *
 * Events: 'state' (state, error), 'rtt' (ms), 'binary' (ArrayBuffer), `msg:<ch>` (message), 'call' (MediaConnection),
 * 'paired' (remote) on every link up, 'left' when the guest said bye (host),
 * 'approval' / 'approval-end' (request: {name, allow(), deny()}) for a device that needs the host's OK.
 */
export class Session extends Emitter {
	constructor({ role, peerId = null, token = null, peerOptions = {}, isTrusted = () => false, guestTurn = () => null }) {
		super();
		this.role = role;
		this.hostId = peerId; // host: our own stable ID; guest: the host's
		this.token = token; // host: expected from guests; guest: sent to the host
		this.peerOptions = peerOptions;
		this.isTrusted = isTrusted;
		this.guestTurn = guestTurn; // host: temporary TURN credentials to send with welcome
		this.hostTurn = null; // guest: what the host sent with welcome (unvalidated)
		this.state = 'idle';
		this.error = null;
		this.id = null;
		this.remote = null; // { peerId, name, deviceId }
		this.rtt = null;
		this.everConnected = false;
		this.idTakenSince = null; // host: since when the server refuses our ID
		this.retryError = null; // guest: why the link dropped or the last attempt failed
		this.peer = null;
		this.ctl = null;
		this.file = null;
		this._gen = 0; // bumped on every link teardown; stale callbacks compare against it
		this._timer = null;
		this._pingTimer = null;
		this._brokerTimer = null;
		this._brokerAttempts = 0;
		this._retryTimer = null;
		this._retryOnOpen = false;
		this._linkAttempts = 0;
		this._opened = false; // registered with the server at least once
		this._auto = false; // the current attempt is an automatic reconnect
		this._pending = null; // host: the approval request being shown
		this._ended = null; // host: device ID we disconnected on purpose
		this._lastSeen = 0;
		this._destroyed = false;
	}

	start() {
		this._createPeer();
	}

	/** Start over after a failure, or reconnect now instead of waiting for the backoff. */
	retry() {
		this._auto = false;
		this._linkAttempts = 0;
		this._clearRetry();
		if (this.role === 'guest' && this.peer?.open) {
			this._connectToHost();
			return;
		}
		this._clearBroker();
		this._teardownLink();
		this._dropPeer();
		this._createPeer();
	}

	/** Fail without starting, e.g. for a link that can't be used. */
	fail(code) {
		this._fail(code);
	}

	/** Release the peer ID and stay failed until `retry()`, e.g. when another tab took over. */
	stop(code) {
		this._halt();
		this._setState('failed', code);
	}

	destroy() {
		this._destroyed = true;
		this._halt();
	}

	/** End the session on purpose. A host refuses the guest's automatic reconnects afterwards. */
	async leave() {
		if (this.state !== 'connected') return;
		const { ctl, remote } = this;
		// Before 'bye': the guest closes the link as soon as it reads it.
		if (this.role === 'host') this._ended = remote?.deviceId ?? null;
		this.send(CH.SYS, { type: 'bye' });
		await sleep(BYE_GRACE);
		if (this.role === 'host' && this.ctl === ctl) this._linkLost();
	}

	/** Call when the page becomes visible or the network returns: check now instead of waiting for timers. */
	checkHealth() {
		if (this._destroyed) return;
		if (this.state === 'failed') {
			if (SIGNALING_ERRORS.has(this.error)) this.retry();
			return;
		}
		const peer = this.peer;
		if (this._opened && peer && !peer.destroyed && peer.disconnected) {
			this._clearBroker();
			this._brokerAttempts = 0;
			this._reviveSignaling();
		}
		if (this.state === 'reconnecting' && this._retryTimer) {
			this._linkAttempts = 0;
			this._attemptReconnect();
		}
		if (this.state === 'connected') {
			const gen = this._gen;
			const asked = Date.now();
			this.send(CH.SYS, { type: 'ping', t: performance.now() });
			setTimeout(() => {
				if (gen === this._gen && this._lastSeen < asked) this._linkLost('lost');
			}, HEALTH_TIMEOUT);
		}
	}

	onMessage(ch, fn) {
		return this.on(`msg:${ch}`, fn);
	}

	send(ch, msg) {
		const conn = this.ctl;
		if (!conn?.open) return false;
		try {
			conn.send({ ...msg, ch });
			return true;
		} catch (err) {
			console.warn('[peerkit] send failed', err);
			return false;
		}
	}

	/** Send one binary message, waiting first if the channel buffer is full. Rejects if the link drops. */
	async sendBinary(data) {
		const conn = this.file;
		if (!conn?.open) throw new Error('Not connected');
		if (conn.dataChannel.bufferedAmount > HIGH_WATER) await drain(conn.dataChannel);
		if (conn !== this.file || !conn.open) throw new Error('Not connected');
		conn.send(data);
	}

	get bufferedAmount() {
		return this.file?.dataChannel?.bufferedAmount ?? 0;
	}

	get maxMessageSize() {
		const max = this.file?.peerConnection?.sctp?.maxMessageSize;
		return Math.min(DEFAULT_MESSAGE_SIZE, max > 0 ? max : DEFAULT_MESSAGE_SIZE);
	}

	/** Send a media stream to the paired device (peerjs MediaConnection). Null when that isn't possible now. */
	call(stream, metadata, options = {}) {
		if (this.state !== 'connected' || !this.peer?.open || !this.remote) return null;
		return this.peer.call(this.remote.peerId, stream, { ...options, metadata }) ?? null;
	}

	// --- peer / signaling ---

	_createPeer() {
		this.id = null;
		this._setState('starting');
		if (typeof Peer !== 'function') {
			this._fail('browser-incompatible');
			return;
		}
		const options = { debug: 1, ...this.peerOptions };
		const peer = (this.peer = this.role === 'host' ? new Peer(this.hostId, options) : new Peer(options));

		peer.on('open', id => {
			if (peer === this.peer) this._onOpen(id);
		});
		peer.on('connection', conn => {
			if (peer === this.peer && this.role === 'host') this._onIncoming(conn);
			else conn.close();
		});
		peer.on('call', call => {
			// Media only from the paired device; the call can arrive just before the file link is up.
			if (peer === this.peer && this.ctl && call.peer === this.remote?.peerId) this.emit('call', call);
			else call.close();
		});
		peer.on('disconnected', () => {
			if (peer === this.peer && this._opened && this.state !== 'failed') this._recoverSignaling();
		});
		peer.on('error', err => {
			if (peer === this.peer && !this._destroyed) this._onPeerError(err);
		});
	}

	_onOpen(id) {
		// Also fires again after every successful reconnect to the server.
		this._opened = true;
		this._brokerAttempts = 0;
		this.id = id;
		const idWasTaken = this.idTakenSince != null;
		this.idTakenSince = null;
		if (this.state === 'starting') {
			if (this.role === 'host') this._setState('waiting');
			else this._connectToHost();
		} else if (this.state === 'reconnecting' && this._retryOnOpen) {
			this._connectToHost();
		} else if (idWasTaken) {
			this._changed();
		}
	}

	_onPeerError(err) {
		const type = err?.type ?? 'unknown';
		console.warn('[peerkit] peer error:', type, err);
		if (this.state === 'failed') return; // keep the first, more meaningful error
		if (type === 'peer-unavailable' || type === 'webrtc') {
			// One broken attempt must not take down a host (and its code) or a working link.
			if (this.role === 'guest' && (this.state === 'connecting' || this.state === 'pending')) this._linkLost(type);
			return;
		}
		if (type === 'unavailable-id' && this.role === 'host') {
			// Usually our own ID from before a reload that the server hasn't released yet.
			this.idTakenSince ??= Date.now();
			if (this.state === 'waiting') this._setState('starting');
			this._recoverSignaling(ID_RETRY);
			this._changed();
			return;
		}
		if (this._opened && SIGNALING_ERRORS.has(type)) {
			if (this.state === 'waiting') this._setState('starting');
			this._recoverSignaling();
			return;
		}
		this._fail(type);
	}

	_recoverSignaling(delay = null) {
		if (this._brokerTimer || this._destroyed) return;
		const wait = delay ?? Math.min(RETRY_MAX, RETRY_MIN * 2 ** this._brokerAttempts++);
		this._brokerTimer = setTimeout(() => {
			this._brokerTimer = null;
			if (!this._destroyed && this.state !== 'failed') this._reviveSignaling();
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
		this.id = null;
		try {
			peer?.destroy();
		} catch {
			// already gone
		}
	}

	// --- guest side ---

	_connectToHost() {
		this._teardownLink();
		this._clearRetry();
		const gen = this._gen;
		this._setState('connecting');
		const ctl = this.peer.connect(this.hostId, { label: LABEL.CTL, serialization: 'json', reliable: true });
		if (gen !== this._gen) return;
		if (!ctl) {
			this._linkLost('disconnected');
			return;
		}
		this._attachCtl(ctl);
		ctl.on('open', () => {
			if (gen === this._gen) this.send(CH.SYS, { type: 'hello', ...identity(), token: this.token, auto: this._auto });
		});
		this._timer = setTimeout(() => {
			if (gen === this._gen) this._linkLost('timeout');
		}, CONNECT_TIMEOUT);
	}

	_scheduleReconnect(error) {
		const delay = Math.min(RETRY_MAX, RETRY_MIN * 2 ** this._linkAttempts++);
		this.retryError = error;
		this._clearRetry();
		this._setState('reconnecting');
		this._retryTimer = setTimeout(() => {
			this._retryTimer = null;
			this._attemptReconnect();
		}, delay);
	}

	_attemptReconnect() {
		this._clearRetry();
		this._auto = true;
		if (this.peer?.open) {
			this._connectToHost();
			return;
		}
		// Signaling is down too: connect as soon as the peer is registered again.
		this._retryOnOpen = true;
		this._setState('reconnecting');
		if (!this._brokerTimer) this._reviveSignaling();
	}

	_clearRetry() {
		clearTimeout(this._retryTimer);
		this._retryTimer = null;
		this._retryOnOpen = false;
	}

	_onPending() {
		if (this.role !== 'guest' || this.state !== 'connecting') return;
		const gen = this._gen;
		clearTimeout(this._timer);
		this._setState('pending');
		this._timer = setTimeout(() => {
			if (gen === this._gen) this._fail('no-answer');
		}, APPROVAL_TIMEOUT + CONNECT_TIMEOUT);
	}

	_onWelcome(msg) {
		if (this.role !== 'guest' || this.file) return;
		if (msg.v !== PROTOCOL_VERSION) {
			this._fail('version');
			return;
		}
		if (typeof msg.token === 'string' && TOKEN_RE.test(msg.token)) this.token = msg.token;
		this.hostTurn = msg.turn ?? null;
		this.remote = { peerId: this.ctl.peer, name: cleanName(msg.name) || 'Device', deviceId: cleanId(msg.deviceId) };
		const gen = this._gen;
		if (this.state === 'pending') this._setState('connecting');
		clearTimeout(this._timer);
		this._timer = setTimeout(() => {
			if (gen === this._gen) this._linkLost('timeout');
		}, CONNECT_TIMEOUT);
		const file = this.peer.connect(this.hostId, { label: LABEL.FILE, serialization: 'raw', reliable: true });
		if (file) this._attachFile(file);
		else this._linkLost('disconnected');
	}

	// --- host side ---

	_onIncoming(conn) {
		if (conn.label === LABEL.FILE) {
			if (this.ctl && this.remote?.peerId === conn.peer && !this.file) this._attachFile(conn);
			else conn.close();
			return;
		}
		if (conn.label !== LABEL.CTL) {
			conn.close();
			return;
		}
		const onHello = msg => {
			if (msg?.ch !== CH.SYS || msg.type !== 'hello') return;
			conn.off('data', onHello);
			clearTimeout(helloTimer);
			this._onHello(conn, msg);
		};
		const helloTimer = setTimeout(() => {
			conn.off('data', onHello);
			if (conn !== this.ctl) conn.close();
		}, CONNECT_TIMEOUT);
		conn.on('data', onHello);
	}

	_onHello(conn, msg) {
		if (msg.v !== PROTOCOL_VERSION) return rejectConn(conn, 'version');
		const remote = { peerId: conn.peer, name: cleanName(msg.name) || 'Device', deviceId: cleanId(msg.deviceId) };
		const current = remote.deviceId != null && remote.deviceId === this.remote?.deviceId;
		// Only the same device (e.g. after a reload) may replace the current guest.
		if (this.ctl && !current) return rejectConn(conn, 'busy');
		if (remote.deviceId != null && remote.deviceId === this._ended) {
			// Disconnected on purpose: refuse its automatic reconnects, but not a deliberate join.
			if (msg.auto) return rejectConn(conn, 'ended');
			this._ended = null;
		}
		const trusted = current || (this.token != null && msg.token === this.token) || this.isTrusted(remote);
		if (trusted) return this._acceptGuest(conn, remote);
		if (this._pending) return rejectConn(conn, 'busy');
		this._askApproval(conn, remote);
	}

	_askApproval(conn, remote) {
		const onClose = () => settle('gone');
		const settle = outcome => {
			if (this._pending !== request) return;
			this._pending = null;
			clearTimeout(timer);
			conn.off('close', onClose);
			this.emit('approval-end', request);
			const free = !this.ctl || this.remote?.deviceId === remote.deviceId;
			if (outcome === 'allow' && conn.open && free) this._acceptGuest(conn, remote);
			else if (outcome === 'allow') rejectConn(conn, 'busy');
			else if (outcome === 'deny') rejectConn(conn, 'denied');
			else if (outcome === 'timeout') rejectConn(conn, 'no-answer');
			else closeConn(conn);
		};
		const request = { name: remote.name, allow: () => settle('allow'), deny: () => settle('deny'), cancel: () => settle('gone') };
		const timer = setTimeout(() => settle('timeout'), APPROVAL_TIMEOUT);
		this._pending = request;
		conn.on('close', onClose);
		conn.send({ ch: CH.SYS, type: 'pending' });
		this.emit('approval', request);
	}

	_acceptGuest(conn, remote) {
		this._teardownLink();
		if (this.state === 'connected') this._setState('waiting');
		const gen = this._gen;
		this.remote = remote;
		this._attachCtl(conn);
		this.send(CH.SYS, { type: 'welcome', ...identity(), token: this.token, turn: this.guestTurn() ?? undefined });
		this._timer = setTimeout(() => {
			if (gen === this._gen && !this.file?.open) this._linkLost();
		}, CONNECT_TIMEOUT);
	}

	// --- link (ctl + file connections) ---

	_attachCtl(conn) {
		const gen = this._gen;
		this.ctl = conn;
		conn.on('data', msg => {
			if (gen !== this._gen) return;
			this._lastSeen = Date.now();
			this._onCtl(msg);
		});
		conn.on('close', () => {
			if (gen === this._gen) this._linkLost();
		});
		conn.on('error', err => {
			console.warn('[peerkit] control connection error', err);
			if (gen === this._gen) this._linkLost();
		});
	}

	_attachFile(conn) {
		const gen = this._gen;
		this.file = conn;
		const onOpen = () => {
			if (gen !== this._gen) return;
			conn.dataChannel.bufferedAmountLowThreshold = LOW_WATER;
			this._onLinkUp();
		};
		if (conn.open) onOpen();
		else conn.on('open', onOpen);
		conn.on('data', data => {
			if (gen === this._gen) this.emit('binary', data);
		});
		conn.on('close', () => {
			if (gen === this._gen) this._linkLost();
		});
		conn.on('error', err => {
			console.warn('[peerkit] file connection error', err);
			if (gen === this._gen) this._linkLost();
		});
	}

	_onCtl(msg) {
		if (!msg || typeof msg !== 'object' || typeof msg.ch !== 'string') return;
		if (msg.ch !== CH.SYS) {
			this.emit(`msg:${msg.ch}`, msg);
			return;
		}
		switch (msg.type) {
			case 'ping':
				this.send(CH.SYS, { type: 'pong', t: msg.t });
				break;
			case 'pong':
				if (typeof msg.t === 'number') {
					this.rtt = Math.max(0, Math.round(performance.now() - msg.t));
					this.emit('rtt', this.rtt);
				}
				break;
			case 'pending':
				this._onPending();
				break;
			case 'welcome':
				this._onWelcome(msg);
				break;
			case 'reject':
				if (this.role === 'guest') this._fail(REJECTIONS.has(msg.reason) ? msg.reason : 'busy');
				break;
			case 'bye':
				if (this.role === 'guest') {
					this._fail('ended');
				} else {
					this.emit('left', this.remote);
					this._linkLost();
				}
				break;
		}
	}

	_onLinkUp() {
		clearTimeout(this._timer);
		const gen = this._gen;
		this.everConnected = true;
		this._linkAttempts = 0;
		this.retryError = null;
		this._lastSeen = Date.now();
		this._pingTimer = setInterval(() => {
			if (gen !== this._gen) return;
			if (Date.now() - this._lastSeen > LOST_AFTER) this._linkLost('lost');
			else this.send(CH.SYS, { type: 'ping', t: performance.now() });
		}, PING_INTERVAL);
		for (const pc of [this.ctl?.peerConnection, this.file?.peerConnection]) {
			pc?.addEventListener('iceconnectionstatechange', () => {
				if (gen === this._gen && (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed')) this._linkLost('lost');
			});
		}
		this._setState('connected');
		this.send(CH.SYS, { type: 'ping', t: performance.now() });
		this.emit('paired', this.remote);
	}

	_linkLost(code = null) {
		const wasConnecting = this.state === 'connecting' || this.state === 'pending';
		this._teardownLink();
		if (this.role === 'host') {
			if (this.state === 'connected') this._setState('waiting');
			return;
		}
		const reason = code ?? (wasConnecting ? 'webrtc' : 'lost');
		if (this.everConnected) this._scheduleReconnect(reason);
		else this._fail(reason);
	}

	_teardownLink() {
		this._gen++;
		clearTimeout(this._timer);
		clearInterval(this._pingTimer);
		const { ctl, file } = this;
		this.ctl = this.file = null;
		this.rtt = null;
		for (const conn of [ctl, file]) closeConn(conn);
	}

	_halt() {
		this._clearBroker();
		this._clearRetry();
		this._pending?.cancel();
		this._teardownLink();
		this._dropPeer();
	}

	_fail(code) {
		this._clearRetry();
		this._pending?.cancel();
		this._teardownLink();
		this._setState('failed', code);
	}

	_setState(state, error = null) {
		if (this._destroyed || (state === this.state && error === this.error)) return;
		this.state = state;
		this.error = error;
		this.emit('state', state, error);
	}

	/** Re-render for details that aren't a state change (e.g. idTakenSince). */
	_changed() {
		if (!this._destroyed) this.emit('state', this.state, this.error);
	}
}

function identity() {
	return { v: PROTOCOL_VERSION, name: device.name, deviceId: device.id };
}

function cleanId(id) {
	return typeof id === 'string' && /^[0-9a-f]{8,64}$/.test(id) ? id : null;
}

function closeConn(conn) {
	try {
		conn?.close();
	} catch {
		// already closed
	}
}

function rejectConn(conn, reason) {
	try {
		conn.send({ ch: CH.SYS, type: 'reject', reason });
	} catch {
		// the guest will time out instead
	}
	setTimeout(() => closeConn(conn), 1000);
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
