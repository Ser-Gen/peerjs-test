// Simulation of app/room.js: several devices on a fake peerjs network with a virtual clock.
const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, ''); // the repo root

// --- virtual clock ---
let now = 1_700_000_000_000;
let seq = 0;
const timers = new Map();
globalThis.setTimeout = (fn, ms = 0, ...args) => {
	const id = ++seq;
	timers.set(id, { id, at: now + Math.max(0, Number(ms) || 0), fn: () => fn(...args) });
	return id;
};
globalThis.clearTimeout = id => timers.delete(id);
globalThis.setInterval = (fn, ms) => {
	const id = ++seq;
	const timer = { id, at: now + ms, fn: null };
	timer.fn = () => {
		timer.at = now + ms;
		timers.set(id, timer);
		fn();
	};
	timers.set(id, timer);
	return id;
};
globalThis.clearInterval = id => timers.delete(id);
Date.now = () => now;
Object.defineProperty(performance, 'now', { value: () => now, configurable: true });
const flush = async () => {
	for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
};
async function advance(ms) {
	const end = now + ms;
	for (;;) {
		await flush();
		let next = null;
		for (const t of timers.values()) if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
		if (!next) break;
		now = next.at;
		timers.delete(next.id);
		next.fn();
	}
	now = end;
	await flush();
}

// --- browser globals the modules touch at import time ---
const store = new Map();
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
globalThis.location = { origin: 'https://peerkit.test', pathname: '/', hash: '', protocol: 'https:' };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });
globalThis.document = { addEventListener() {}, visibilityState: 'visible' };
const warnings = [];
console.warn = (...args) => warnings.push(args.map(String).join(' '));

// --- fake peerjs ---
class Em {
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

const net = { peers: new Map(), silent: new Set(), mitm: false, blocked: () => false, all: new Set() };
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

class FakePeer extends Em {
	constructor(id, options) {
		super();
		this.id = id;
		this.device = options.device;
		this.cert = cert();
		this.open = false;
		this.destroyed = false;
		this.disconnected = false;
		this.everOpen = false;
		this.conns = new Set();
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
	call() {
		return { on() {}, close() {} };
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
	}
}
globalThis.Peer = FakePeer;

const { Room } = await import(`${ROOT}/app/room.js`);
const { newRoomCode, roomIds } = await import(`${ROOT}/app/rooms.js`);
const { CH } = await import(`${ROOT}/app/protocol.js`);

let failures = 0;
function check(name, ok, extra = '') {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
	if (!ok) failures++;
}

let deviceCount = 0;
const fakeIce = () => ({ forRoom: null, adopt: () => false });
function device(name, code, { known = true, claimFirst = false } = {}) {
	const identity = { id: (++deviceCount).toString(16).padStart(16, 'a'), name };
	const room = new Room({ code, ice: fakeIce(), known, identity, peerOptions: {} });
	room.peerOptions = { device: room }; // lets the fake network know which device a peer belongs to
	room.inbox = [];
	room.on('msg:test', (msg, from) => room.inbox.push([msg.text, from.name]));
	if (claimFirst) room.claimFirst = true;
	room.start();
	return room;
}
const names = room => room.members.map(m => m.name).sort().join(',');
const anchors = rooms => rooms.filter(r => r.isAnchor).length;

// 1. Create, join, mesh.
const code = newRoomCode();
const a = device('A', code, { claimFirst: true });
await advance(200);
check('the creator holds the anchor and the room is open', a.state === 'open' && a.isAnchor);
const b = device('B', code, { known: false });
await advance(500);
check('a newcomer joins through the anchor', b.state === 'open' && names(b) === 'A' && names(a) === 'B');
const c = device('C', code, { known: false });
await advance(500);
check('a third device links with both', names(c) === 'A,B' && names(a) === 'B,C' && names(b) === 'A,C');
check('one link per pair, no duplicates left', [a, b, c].every(r => r.links.size === 2 && r.incoming.size === 0));
await advance(100);
check('members know who is linked to whom', b.isLinked(a.self.peerId, c.self.peerId) && c.isLinked(a.self.peerId, b.self.peerId));
check('members know who holds the anchor', b.members.find(m => m.name === 'A')?.anchor === true);

// 2. Messages.
b.send('test', { type: 'x', text: 'to all' });
c.send('test', { type: 'x', text: 'to A only' }, a.self.peerId);
await advance(100);
check('send to all reaches everyone', a.inbox.some(([t, f]) => t === 'to all' && f === 'B') && c.inbox.some(([t]) => t === 'to all'));
check('send to one reaches only that member', a.inbox.some(([t]) => t === 'to A only') && !b.inbox.some(([t]) => t === 'to A only'));

// 3. The anchor leaves on purpose; someone takes over; a newcomer still gets in.
const leaving = a.leave();
await advance(400);
await leaving;
check('bye removes the member at once', names(b) === 'C' && names(c) === 'B');
await advance(4000);
check('exactly one remaining member claims the anchor', anchors([b, c]) === 1, `B ${b.isAnchor}, C ${c.isAnchor}`);
const d = device('D', code, { known: false });
await advance(1000);
check('a newcomer joins after the handover', names(d) === 'B,C' && names(b) === 'C,D' && names(c) === 'B,D');

// 4. The anchor holder drops off the network without a word.
const holder = b.isAnchor ? b : c;
const other = holder === b ? c : b;
net.silent.add(holder);
await advance(16000);
check('the silent member is dropped after the ping timeout', !names(other).includes(holder.self.name) && !names(d).includes(holder.self.name), `${other.self.name}: ${names(other)}, D: ${names(d)}`);
await advance(60000);
check('while the server still holds its ID, nobody else can take the anchor', anchors([other, d]) === 0);
const e = device('E', code, { known: true });
await advance(30000);
check('a newcomer keeps looking meanwhile', e.state === 'joining' && e.entryFailures > 0, `${e.state}, ${e.entryFailures} failures`);
// The server notices the dead socket (about 100 s on 0.peerjs.com) and frees the ID.
for (const peer of net.all) if (peer.device === holder) peer.destroy();
await advance(40000);
check('after the server frees the ID, one member takes the anchor', anchors([other, d, e]) === 1, [other, d, e].map(r => `${r.self.name}:${r.isAnchor}`).join(' '));
check('and the newcomer gets in', e.state === 'open' && names(e) === [other.self.name, 'D'].sort().join(','), `${e.state} ${names(e)}`);

// 5. A link drops while both devices stay online: the lower peer ID dials again.
const [x, y] = [d, e].sort((p, q) => (p.self.peerId < q.self.peerId ? -1 : 1));
x.links.get(y.self.peerId).ctl.close();
await advance(200);
check('the link goes down on both', !names(x).includes(y.self.name) || !names(y).includes(x.self.name));
await advance(5000);
check('and comes back by itself', names(x).includes(y.self.name) && names(y).includes(x.self.name));

// 6. A reload: same device, new peer ID, no bye.
const eIdentity = e.identity;
e.destroy();
const e2 = new Room({ code, ice: fakeIce(), known: true, identity: eIdentity });
e2.peerOptions = { device: e2 };
e2.start();
await advance(1500);
check('after a reload the device is back once, not twice', names(d) === [other.self.name, 'E'].sort().join(',') && d.members.length === 2, names(d));

// 7. Unknown room nobody is in.
const lonely = device('L', newRoomCode(), { known: false });
await advance(500);
check('an empty room typed in is "not found"', lonely.state === 'failed' && lonely.error === 'not-found');
lonely.waitHere();
await advance(500);
check('"wait here" opens it', lonely.state === 'open' && lonely.isAnchor);

// 8. Someone who only knows the anchor peer ID, not the code.
const intruder = device('I', newRoomCode(), { known: false });
intruder.ids = { ...roomIds(intruder.code), anchorId: roomIds(code).anchorId };
intruder.retry();
await advance(1000);
check('a wrong room key is refused', intruder.state === 'failed' && intruder.error === 'denied' && !names(d).includes('I'), `${intruder.state} ${intruder.error}`);

// 9. A relay in the middle (different DTLS certificates on each side).
net.mitm = true;
const victim = device('V', code, { known: true });
await advance(3000);
check('a connection with swapped certificates is refused', victim.state !== 'open' || victim.members.length === 0, `${victim.state} ${victim.error} ${names(victim)}`);
victim.destroy();
net.mitm = false;

// 10. Both sides dial each other at the same moment.
const p = device('P', newRoomCode(), { claimFirst: true });
const q = device('Q', p.code, { known: false });
await advance(1000);
p.links.get(q.self.peerId).close('lost');
q.links.get(p.self.peerId)?.close('lost');
p._dial(q.self.peerId);
q._dial(p.self.peerId);
await advance(2000);
check('simultaneous dials end with one link each', p.links.size === 1 && q.links.size === 1 && names(p) === 'Q' && names(q) === 'P', `${p.links.size} ${q.links.size}`);

// 11. Tool messages sent the moment a link comes up are not lost.
const r1 = device('R1', newRoomCode(), { claimFirst: true });
r1.on('link-up', member => r1.send('test', { type: 'x', text: 'hello at link-up' }, member.peerId));
await advance(200);
const r2 = device('R2', r1.code, { known: false });
r2.on('link-up', member => r2.send('test', { type: 'x', text: 'reply at link-up' }, member.peerId));
await advance(1000);
check('messages sent at link-up arrive on both sides', r2.inbox.some(([t]) => t === 'hello at link-up') && r1.inbox.some(([t]) => t === 'reply at link-up'));

// 12. Signaling lost while in the room: links stay, and the device reconnects to the server.
const s1 = device('S1', newRoomCode(), { claimFirst: true });
await advance(200);
const s2 = device('S2', s1.code, { known: false });
await advance(800);
s2.peer.disconnected = true;
s2.peer.open = false;
s2.peer.emit('disconnected');
await advance(100);
check('losing the server keeps the link', s2.signalingLost && names(s2) === 'S1');
await advance(3000);
check('and the server connection comes back', !s2.signalingLost && s2.peer.open);

// 13. Full room.
const big = device('F0', newRoomCode(), { claimFirst: true });
await advance(200);
const crowd = [];
for (let i = 1; i < 9; i++) {
	crowd.push(device(`F${i}`, big.code, { known: false }));
	await advance(800);
}
check('the ninth device is refused as full', crowd.at(-1).state === 'failed' && crowd.at(-1).error === 'full', `${crowd.at(-1).state} ${crowd.at(-1).error}`);
check('the first eight form a full mesh', [big, ...crowd.slice(0, 7)].every(room => room.members.length === 7));

const unexpected = warnings.filter(w => !/peer error|connection error/.test(w));
check('no unexpected warnings', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
