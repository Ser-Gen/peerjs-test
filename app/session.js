/* global Peer */
import { Emitter } from './emitter.js';
import { CH, LABEL, PROTOCOL_VERSION } from './protocol.js';
import { deviceId, deviceName } from './util.js';

const PING_INTERVAL = 2000;
const LOST_AFTER = 15000;
const CONNECT_TIMEOUT = 20000;
const BROKER_RETRY = 3000;

// Backpressure for the binary channel: pause above HIGH, resume below LOW.
const HIGH_WATER = 2 * 1024 * 1024;
const LOW_WATER = 512 * 1024;
const DEFAULT_MESSAGE_SIZE = 64 * 1024;

// Losing the signaling server doesn't break an established P2P link.
const SIGNALING_ERRORS = new Set(['disconnected', 'network', 'server-error', 'socket-error', 'socket-closed']);

const ERRORS = {
	'browser-incompatible': ['Browser not supported', 'This browser does not support WebRTC.'],
	'invalid-id': ['Invalid link', 'The session code in this link is not valid.'],
	'invalid-key': ['Server rejected the key', 'The signaling server did not accept the API key.'],
	network: ['Server unreachable', 'Could not reach the signaling server. Check the internet connection and the server settings.'],
	'server-error': ['Server error', 'The signaling server did not respond as expected. Check the server settings or try again in a moment.'],
	'bad-link': ['Invalid link', 'The server settings in this link are damaged. Ask for a new link or scan the QR code again.'],
	'socket-error': ['Server connection failed', 'The connection to the signaling server failed.'],
	'socket-closed': ['Server connection closed', 'The signaling server closed the connection.'],
	disconnected: ['Server connection lost', 'Lost the connection to the signaling server.'],
	'ssl-unavailable': ['HTTPS not available', 'The signaling server does not support secure connections.'],
	'unavailable-id': ['ID already in use', 'This session ID is taken. Try again.'],
	'peer-unavailable': ['Host not found', 'The link may be stale, or the host page was closed or reloaded.'],
	webrtc: ['Direct connection failed', 'The devices could not open a direct connection.'],
	timeout: ['Connection timed out', 'The devices could not reach each other. A strict network (NAT or firewall) may be blocking direct connections.'],
	lost: ['Connection lost', 'The other device stopped responding.'],
	busy: ['Host is busy', 'This host is already connected to another device.'],
	version: ['Version mismatch', 'The devices run different app versions. Reload both pages.'],
};

export function describeError(code) {
	const [title, text] = ERRORS[code] ?? ['Something went wrong', code ? `Error: ${code}` : 'Unknown error.'];
	return { title, text };
}

/**
 * One 1-to-1 session between a host (shows the QR) and a guest (opened the link).
 *
 * States: idle → starting → waiting (host) | connecting (guest) → connected;
 * failed carries an error code. A host whose guest leaves goes back to waiting.
 *
 * Events: 'state' (state, error), 'rtt' (ms), 'binary' (ArrayBuffer), `msg:<ch>` (message).
 */
export class Session extends Emitter {
	constructor({ joinId = null, peerOptions = {} } = {}) {
		super();
		this.role = joinId != null ? 'guest' : 'host';
		this.hostId = joinId;
		this.peerOptions = peerOptions;
		this.state = 'idle';
		this.error = null;
		this.id = null;
		this.remote = null; // { peerId, name, deviceId }
		this.rtt = null;
		this.everConnected = false;
		this.peer = null;
		this.ctl = null;
		this.file = null;
		this._gen = 0; // bumped on every link teardown; stale callbacks compare against it
		this._timer = null;
		this._pingTimer = null;
		this._brokerTimer = null;
		this._lastSeen = 0;
		this._destroyed = false;
	}

	start() {
		this._createPeer();
	}

	retry() {
		this._teardownLink();
		if (this.role === 'guest' && this.peer?.open && !this.peer.destroyed) {
			this._connectToHost();
			return;
		}
		this.peer?.destroy();
		this._createPeer();
	}

	/** Fail without starting, e.g. for a link that can't be used. */
	fail(code) {
		this._fail(code);
	}

	destroy() {
		this._destroyed = true;
		this._teardownLink();
		clearTimeout(this._brokerTimer);
		this.peer?.destroy();
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

	// --- peer / signaling ---

	_createPeer() {
		this.id = null;
		this._setState('starting');
		if (typeof Peer !== 'function') {
			this._fail('browser-incompatible');
			return;
		}
		const peer = (this.peer = new Peer({ debug: 1, ...this.peerOptions }));

		peer.on('open', id => {
			if (peer !== this.peer || this.state !== 'starting') return; // reconnects to the broker re-emit 'open'
			this.id = id;
			if (this.role === 'host') this._setState('waiting');
			else this._connectToHost();
		});
		peer.on('connection', conn => {
			if (peer === this.peer && this.role === 'host') this._onIncoming(conn);
			else conn.close();
		});
		peer.on('disconnected', () => {
			if (peer === this.peer && !this._destroyed) this._reconnectBroker();
		});
		peer.on('error', err => {
			if (peer === this.peer && !this._destroyed) this._onPeerError(err);
		});
	}

	_onPeerError(err) {
		const type = err?.type ?? 'unknown';
		console.warn('[peerkit] peer error:', type, err);
		if (this.state === 'failed') return; // keep the first, more meaningful error
		// A single broken incoming attempt must not take down the host (and invalidate its QR).
		if (this.role === 'host' && (type === 'webrtc' || type === 'peer-unavailable')) return;
		if (this.state === 'connected' && type === 'webrtc') return;
		// Once registered, keep the same ID and reconnect to the broker instead of failing.
		if (this.id && SIGNALING_ERRORS.has(type) && (this.state === 'connected' || this.state === 'waiting' || this.state === 'starting')) {
			if (this.state === 'waiting') this._setState('starting');
			this._reconnectBroker();
			return;
		}
		this._fail(type);
	}

	_reconnectBroker() {
		if (this._brokerTimer) return;
		this._brokerTimer = setTimeout(() => {
			this._brokerTimer = null;
			const peer = this.peer;
			if (peer && !peer.destroyed && peer.disconnected) peer.reconnect();
		}, BROKER_RETRY);
	}

	// --- guest side ---

	_connectToHost() {
		this._teardownLink();
		const gen = this._gen;
		this._setState('connecting');
		const ctl = this.peer.connect(this.hostId, { label: LABEL.CTL, serialization: 'json', reliable: true });
		if (!ctl) {
			this._fail('disconnected');
			return;
		}
		this._attachCtl(ctl);
		ctl.on('open', () => {
			if (gen === this._gen) this.send(CH.SYS, { type: 'hello', ...identity() });
		});
		this._timer = setTimeout(() => {
			if (gen === this._gen) this._fail('timeout');
		}, CONNECT_TIMEOUT);
	}

	_onWelcome(msg) {
		if (this.role !== 'guest' || this.file) return;
		if (msg.v !== PROTOCOL_VERSION) {
			this._fail('version');
			return;
		}
		this.remote = { peerId: this.ctl.peer, name: cleanName(msg.name), deviceId: msg.deviceId };
		const file = this.peer.connect(this.hostId, { label: LABEL.FILE, serialization: 'raw', reliable: true });
		if (file) this._attachFile(file);
		else this._fail('disconnected');
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
		const reject = reason => {
			conn.send({ ch: CH.SYS, type: 'reject', reason });
			setTimeout(() => conn.close(), 1000);
		};
		if (msg.v !== PROTOCOL_VERSION) return reject('version');
		// Only the same tab (e.g. after a reload) may replace the current guest.
		if (this.ctl && this.remote?.deviceId !== msg.deviceId) return reject('busy');

		this._teardownLink();
		if (this.state === 'connected') this._setState('waiting');
		const gen = this._gen;
		this.remote = { peerId: conn.peer, name: cleanName(msg.name), deviceId: msg.deviceId };
		this._attachCtl(conn);
		this.send(CH.SYS, { type: 'welcome', ...identity() });
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
			case 'welcome':
				this._onWelcome(msg);
				break;
			case 'reject':
				if (this.role === 'guest') this._fail(msg.reason === 'version' ? 'version' : 'busy');
				break;
		}
	}

	_onLinkUp() {
		clearTimeout(this._timer);
		const gen = this._gen;
		this.everConnected = true;
		this._lastSeen = Date.now();
		this._pingTimer = setInterval(() => {
			if (gen !== this._gen) return;
			if (Date.now() - this._lastSeen > LOST_AFTER) this._linkLost();
			else this.send(CH.SYS, { type: 'ping', t: performance.now() });
		}, PING_INTERVAL);
		for (const pc of [this.ctl?.peerConnection, this.file?.peerConnection]) {
			pc?.addEventListener('iceconnectionstatechange', () => {
				if (gen === this._gen && (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed')) this._linkLost();
			});
		}
		this._setState('connected');
		this.send(CH.SYS, { type: 'ping', t: performance.now() });
	}

	_linkLost() {
		const wasConnecting = this.state === 'connecting';
		this._teardownLink();
		if (this.role === 'host') this._setState('waiting');
		else this._fail(wasConnecting ? 'webrtc' : 'lost');
	}

	_teardownLink() {
		this._gen++;
		clearTimeout(this._timer);
		clearInterval(this._pingTimer);
		const { ctl, file } = this;
		this.ctl = this.file = null;
		this.rtt = null;
		for (const conn of [ctl, file]) {
			try {
				conn?.close();
			} catch {
				// already closed
			}
		}
	}

	_fail(code) {
		this._teardownLink();
		this._setState('failed', code);
	}

	_setState(state, error = null) {
		if (this._destroyed || (state === this.state && error === this.error)) return;
		this.state = state;
		this.error = error;
		this.emit('state', state, error);
	}
}

function identity() {
	return { v: PROTOCOL_VERSION, name: deviceName(), deviceId: deviceId() };
}

function cleanName(name) {
	return String(name || 'Device').slice(0, 60);
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
