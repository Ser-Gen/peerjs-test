// --- fake peerjs ---
export class Em {
	#l = new Map();
	on(type, fn) {
		if (!this.#l.has(type)) this.#l.set(type, new Set());
		this.#l.get(type).add(fn);
		return this;
	}
	off(type, fn) {
		this.#l.get(type)?.delete(fn);
	}
	emit(type, ...args) {
		for (const fn of [...(this.#l.get(type) ?? [])]) fn(...args);
	}
}

export const net = { peers: new Map(), silent: new Set(), mitm: false, blocked: () => false, all: new Set() };
const cert = () => `sha-256 ${Array.from({ length: 32 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase()).join(':')}`;
const isSilent = peer => net.silent.has(peer.device);

class FakeConn extends Em {
	constructor(owner, peer, { label, serialization }) {
		super();
		this.owner = owner;
		this.peer = peer;
		this.label = label;
		this.serialization = serialization;
		this.open = false;
		this.closed = false;
		this.other = null;
		this.dataChannel = { bufferedAmount: 0, readyState: 'connecting', addEventListener() {}, removeEventListener() {} };
		this.peerConnection = null;
		owner.conns.add(this);
	}
	_open() {
		this.open = true;
		this.dataChannel.readyState = 'open';
		this.emit('open');
	}
	send(data) {
		if (!this.open) throw new Error('not open');
		const other = this.other;
		if (isSilent(this.owner) || isSilent(other.owner)) return;
		// peerjs hands binary over as an ArrayBuffer of its own, whatever view was sent.
		const payload = this.serialization === 'json' ? JSON.parse(JSON.stringify(data))
			: ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data;
		setTimeout(() => {
			if (other.open && !other.closed && !isSilent(other.owner) && !isSilent(this.owner)) other.emit('data', payload);
		}, 2);
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		this.open = false;
		this.dataChannel.readyState = 'closed';
		this.owner.conns.delete(this);
		this.emit('close');
		const other = this.other;
		if (other && !other.closed && !isSilent(this.owner) && !isSilent(other.owner)) setTimeout(() => other.close(), 2);
	}
}

export class FakePeer extends Em {
	constructor(id, options) {
		super();
		this.id = id;
		this.device = options.device ?? options.config?.device ?? null;
		this.cert = cert();
		this.open = false;
		this.destroyed = false;
		this.disconnected = false;
		this.everOpen = false;
		this.conns = new Set();
		this.calls = new Set();
		net.all.add(this);
		setTimeout(() => this._register(), 3);
	}
	_register() {
		if (this.destroyed || isSilent(this)) return;
		const holder = net.peers.get(this.id);
		if (holder && holder !== this) {
			this.emit('error', { type: 'unavailable-id', message: `ID "${this.id}" is taken` });
			if (!this.everOpen) this.destroyed = true;
			else this.disconnected = true;
			return;
		}
		net.peers.set(this.id, this);
		this.open = true;
		this.disconnected = false;
		this.everOpen = true;
		this.emit('open', this.id);
	}
	connect(id, opts) {
		if (!this.open || isSilent(this)) return undefined;
		const local = new FakeConn(this, id, opts);
		setTimeout(() => {
			if (local.closed) return;
			const target = net.peers.get(id);
			if (!target || target.destroyed) {
				setTimeout(() => this.emit('error', { type: 'peer-unavailable', message: `Could not connect to peer ${id}` }), 50);
				return;
			}
			if (isSilent(target) || net.blocked(this, target)) return; // never answers
			const remote = new FakeConn(target, this.id, opts);
			local.other = remote;
			remote.other = local;
			const fake = net.mitm ? cert() : null;
			local.peerConnection = { localDescription: { sdp: `a=fingerprint:${this.cert}` }, remoteDescription: { sdp: `a=fingerprint:${fake ?? target.cert}` }, addEventListener() {} };
			remote.peerConnection = { localDescription: { sdp: `a=fingerprint:${target.cert}` }, remoteDescription: { sdp: `a=fingerprint:${fake ?? this.cert}` }, addEventListener() {} };
			target.emit('connection', remote);
			setTimeout(() => {
				if (local.closed || remote.closed) return;
				local._open();
				remote._open();
			}, 5);
		}, 5);
		return local;
	}
	/** A media call. The answer carries the answerer's own stream back, the way peerjs does it. */
	call(id, stream, options = {}) {
		if (!this.open || isSilent(this)) return undefined;
		const local = new FakeMediaConnection(this, id, options.metadata ?? {}, stream ?? null);
		setTimeout(() => {
			const target = net.peers.get(id);
			if (local.closed || !target || target.destroyed || isSilent(this) || isSilent(target) || net.blocked(this, target)) return;
			const remote = new FakeMediaConnection(target, this.id, options.metadata ?? {}, null);
			remote.connectionId = local.connectionId;
			local.other = remote;
			remote.other = local;
			target.emit('call', remote);
		}, 5);
		return local;
	}
	reconnect() {
		this.disconnected = false;
		setTimeout(() => this._register(), 3);
	}
	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		this.open = false;
		if (net.peers.get(this.id) === this) net.peers.delete(this.id);
		for (const conn of [...this.conns]) conn.close();
		for (const call of [...this.calls]) call.close();
	}
}

// --- fake media ---

export class FakeTrack {
	constructor(kind = 'audio', settings = {}) {
		this.kind = kind;
		this.enabled = true;
		this.readyState = 'live';
		this.contentHint = '';
		this.settings = settings;
		this.listeners = []; // a remote track tells its receiver when media starts and stops coming through
	}
	getSettings() {
		return { ...this.settings };
	}
	stop() {
		this.readyState = 'ended';
	}
	/** A clone is a track of its own: stopping it leaves the original alone (app/voice.js taps one for levels). */
	clone() {
		const copy = new FakeTrack(this.kind, this.settings);
		copy.enabled = this.enabled;
		copy.origin = this.origin ?? this;
		return copy;
	}
	addEventListener(type, fn) {
		this.listeners.push([type, fn]);
	}
	removeEventListener(type, fn) {
		this.listeners = this.listeners.filter(([t, f]) => t !== type || f !== fn);
	}
	/** 'mute' when media stops coming through this track, 'unmute' when it starts. */
	fire(type) {
		for (const [t, fn] of [...this.listeners]) if (t === type) fn({ type });
	}
}

let streams = 0;
export class FakeMediaStream {
	constructor(kinds = ['audio']) {
		this.id = `stream-${++streams}`;
		this.tracks = kinds.map(kind => (kind instanceof FakeTrack ? kind : new FakeTrack(kind)));
	}
	getTracks() {
		return [...this.tracks];
	}
	getAudioTracks() {
		return this.tracks.filter(track => track.kind === 'audio');
	}
	getVideoTracks() {
		return this.tracks.filter(track => track.kind === 'video');
	}
	addTrack(track) {
		this.tracks.push(track);
	}
	removeTrack(track) {
		this.tracks = this.tracks.filter(other => other !== track);
	}
}

let calls = 0;

/**
 * peerjs MediaConnection: `answer(stream)` opens it, and each side gets the other's stream if it sent one. Both
 * ends share a `connectionId`. Closing one end doesn't close the other: peerjs sends nothing, and the other end
 * stays until ICE gives up on it, which can take half a minute or never happen.
 */
export class FakeMediaConnection extends Em {
	constructor(owner, peer, metadata, stream) {
		super();
		this.type = 'media';
		this.connectionId = `mc_${++calls}`;
		this.owner = owner;
		this.peer = peer;
		this.metadata = metadata;
		this.localStream = stream;
		this.open = false;
		this.closed = false;
		this.answered = false;
		this.other = null;
		this.senders = sendersFor(stream);
		this.peerConnection = { getSenders: () => this.senders, addEventListener() {}, removeEventListener() {} };
		owner.calls.add(this);
	}
	answer(stream = null) {
		if (this.closed || this.answered) return;
		this.answered = true;
		this.localStream = stream;
		this.senders = sendersFor(stream);
		setTimeout(() => {
			const other = this.other;
			if (this.closed || !other || other.closed) return;
			this.open = other.open = true;
			if (other.localStream) this.emit('stream', other.localStream);
			if (this.localStream) other.emit('stream', this.localStream);
		}, 5);
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		this.open = false;
		this.owner.calls.delete(this);
		this.emit('close');
	}
}

const sendersFor = stream => (stream?.getTracks() ?? []).map(track => {
	const sender = {
		track,
		async replaceTrack(next) {
			sender.track = next;
		},
	};
	return sender;
});

// --- fake RTCPeerConnection, for media calls negotiated over a link (app/mediacall.js) ---

const pcs = new Map();
let pcCount = 0;

/**
 * Enough of RTCPeerConnection for app/mediacall.js. An SDP names the connection that made it; applying the
 * other side's description pairs the two, hands over the tracks it sends ('track', with its stream, the same
 * objects the other side added) and, once both have both descriptions, connects ICE. `rtc.block` stops ICE
 * from ever connecting between two connections, so a failure can be simulated.
 */
export const rtc = { block: () => false, made: [] };

export class FakeRTCPeerConnection {
	constructor(config = {}) {
		this.id = ++pcCount;
		this.config = config;
		this.senders = [];
		this.streams = [];
		this.localDescription = null;
		this.remoteDescription = null;
		this.signalingState = 'stable';
		this.iceConnectionState = 'new';
		this.connectionState = 'new';
		this.candidates = [];
		this.other = null;
		this.closed = false;
		this.onicecandidate = this.ontrack = this.oniceconnectionstatechange = null;
		pcs.set(this.id, this);
		rtc.made.push(this);
	}
	addTrack(track, stream) {
		const sender = { track, async replaceTrack(next) { sender.track = next; } };
		this.senders.push(sender);
		if (stream && !this.streams.includes(stream)) this.streams.push(stream);
		return sender;
	}
	getSenders() {
		return [...this.senders];
	}
	async createOffer(options = {}) {
		return { type: 'offer', sdp: `v=0\r\na=fake-pc:${this.id}\r\na=restart:${options.iceRestart ? 1 : 0}\r\n` };
	}
	async createAnswer() {
		return { type: 'answer', sdp: `v=0\r\na=fake-pc:${this.id}\r\n` };
	}
	async setLocalDescription(desc) {
		if (this.closed) throw new Error('closed');
		this.localDescription = desc;
		this.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable';
		setTimeout(() => {
			if (!this.closed) this.onicecandidate?.({ candidate: { candidate: `candidate:${this.id} 1 udp 1 192.0.2.1 9 typ host`, sdpMid: '0', sdpMLineIndex: 0 } });
		}, 1);
	}
	async setRemoteDescription(desc) {
		if (this.closed) throw new Error('closed');
		const id = Number(/a=fake-pc:(\d+)/.exec(desc.sdp)?.[1]);
		const other = pcs.get(id);
		if (!other) throw new Error('unknown description');
		const fresh = this.other !== other;
		this.other = other;
		this.remoteDescription = desc;
		this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
		if (fresh) for (const stream of other.streams) for (const track of stream.getTracks()) this.ontrack?.({ track, streams: [stream] });
		if (desc.type === 'answer') this._connect();
	}
	async addIceCandidate(candidate) {
		if (!this.remoteDescription) throw new Error('no remote description');
		this.candidates.push(candidate);
	}
	/** After the answer: both ends are negotiated, ICE runs (or fails) for both. */
	_connect() {
		const other = this.other;
		this._ice('checking');
		other._ice('checking');
		setTimeout(() => {
			if (this.closed || other.closed) return;
			const state = rtc.block(this, other) ? 'failed' : 'connected';
			this._ice(state);
			other._ice(state);
		}, 3);
	}
	_ice(state) {
		if (this.closed || this.iceConnectionState === state) return;
		this.iceConnectionState = state;
		this.connectionState = state;
		this.oniceconnectionstatechange?.();
	}
	close() {
		this.closed = true;
		this.signalingState = 'closed';
		this.iceConnectionState = 'closed';
		this.connectionState = 'closed';
		pcs.delete(this.id);
	}
}
