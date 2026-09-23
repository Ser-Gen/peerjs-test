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
		const payload = this.serialization === 'json' ? JSON.parse(JSON.stringify(data)) : data;
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
	}
	getSettings() {
		return { ...this.settings };
	}
	stop() {
		this.readyState = 'ended';
	}
	addEventListener() {}
	removeEventListener() {}
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

/** peerjs MediaConnection: `answer(stream)` opens it, and each side gets the other's stream if it sent one. */
export class FakeMediaConnection extends Em {
	constructor(owner, peer, metadata, stream) {
		super();
		this.type = 'media';
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
		const other = this.other;
		if (other && !other.closed) setTimeout(() => other.close(), 2);
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
