// app/voice.js in a room: who dials, listeners without a microphone, mute, and calls that come and go.
// The room is faked (like editor-sync-test.mjs), the media connections are the ones from dom/fakenet.mjs.
const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, ''); // the repo root

// --- browser globals the modules touch at import time ---
const store = new Map();
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.localStorage = {
	getItem: k => store.get(k) ?? null,
	setItem: (k, v) => store.set(k, String(v)),
	removeItem: k => store.delete(k),
};
const element = () => ({
	className: '',
	autoplay: false,
	srcObject: null,
	volume: 1,
	muted: false,
	children: [],
	append(...nodes) {
		this.children.push(...nodes);
	},
	remove() {},
	async play() {},
});
globalThis.document = { createElement: element, body: element(), addEventListener() {}, visibilityState: 'visible' };
const mic = { available: true, error: 'NotFoundError', devices: [{ kind: 'audioinput', deviceId: 'mic-1', label: 'Built-in' }] };
Object.defineProperty(globalThis, 'navigator', {
	value: {
		userAgent: 'node',
		mediaDevices: {
			async getUserMedia() {
				if (!mic.available) throw new DOMException('no', mic.error);
				return new FakeMediaStream(['audio']);
			},
			async enumerateDevices() {
				return mic.devices;
			},
		},
	},
	configurable: true,
});

const { FakeMediaConnection, FakeMediaStream, FakeTrack } = await import('./dom/fakenet.mjs');
globalThis.MediaStream = FakeMediaStream;

// --- fake Web Audio: enough to read a level from a stream ---
const loud = new Set(); // the tracks that are speaking right now
const taps = []; // every stream handed to the AudioContext
const levelOf = stream => ((stream?.getTracks() ?? []).some(track => loud.has(track.origin ?? track)) ? 0.2 : 0);
globalThis.AudioContext = class {
	constructor() {
		this.state = 'running';
	}
	createMediaStreamSource(stream) {
		taps.push(stream);
		return { connect: analyser => (analyser.stream = stream), disconnect() {} };
	}
	createAnalyser() {
		return {
			fftSize: 512,
			stream: null,
			getByteTimeDomainData(data) {
				data.fill(128 + Math.round(levelOf(this.stream) * 128));
			},
		};
	}
	async resume() {}
	async close() {
		this.state = 'closed';
	}
};
const { Emitter } = await import(`${ROOT}/app/emitter.js`);
const { Voice } = await import(`${ROOT}/app/voice.js`);

const LEVEL_EVERY = 100; // the numbers app/voice.js works with
const SPEAKING_HOLD = 400;
const REDIAL_DELAY = 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const settle = () => sleep(60); // messages and calls take a few milliseconds each way
let failures = 0;
function check(name, ok, extra = '') {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
	if (!ok) failures++;
}

// --- a room of fake members ---

const holder = () => ({ calls: new Set() });

class FakeRoom extends Emitter {
	constructor(name, peerId) {
		super();
		this.state = 'open';
		this.signalingLost = false;
		this.offline = false; // the signaling server is away: peerjs can make no call
		this.self = { peerId, deviceId: `dev-${name}`, name, color: '#2f6fed' };
		this.linked = new Map(); // peerId → FakeRoom
		this.calls = []; // every call this member made
	}
	get members() {
		return [...this.linked.values()].map(room => ({ ...room.self }));
	}
	member(peerId) {
		const room = this.linked.get(peerId);
		return room ? { ...room.self } : null;
	}
	send(ch, msg, to = null) {
		const targets = to ? [to].filter(id => this.linked.has(id)) : [...this.linked.keys()];
		for (const id of targets) {
			const room = this.linked.get(id);
			const copy = JSON.parse(JSON.stringify(msg));
			setTimeout(() => room.emit(`msg:${ch}`, copy, { ...this.self }), 1);
		}
		return targets.length;
	}
	/** One media call, wired to the answering side the way the fake network does it. */
	call(to, stream, metadata) {
		const room = this.linked.get(to);
		if (!room || this.offline) return null;
		const mine = new FakeMediaConnection(holder(), to, metadata, stream ?? null);
		const theirs = new FakeMediaConnection(holder(), this.self.peerId, metadata, null);
		mine.other = theirs;
		theirs.other = mine;
		this.calls.push(mine);
		setTimeout(() => room.emit('call', theirs, { ...this.self }), 1);
		return mine;
	}
}

function member(name, peerId) {
	const room = new FakeRoom(name, peerId);
	return { name, room, voice: new Voice(room) };
}

function link(a, b) {
	a.room.linked.set(b.room.self.peerId, b.room);
	b.room.linked.set(a.room.self.peerId, a.room);
	a.room.emit('link-up', { ...b.room.self });
	b.room.emit('link-up', { ...a.room.self });
}

function unlink(a, b) {
	a.room.linked.delete(b.room.self.peerId);
	b.room.linked.delete(a.room.self.peerId);
	a.room.emit('link-down', { ...b.room.self });
	b.room.emit('link-down', { ...a.room.self });
}

const peerOf = (side, other) => side.voice.peers.get(other.room.self.peerId);
const callBetween = (side, other) => peerOf(side, other)?.call ?? null;
const hears = (side, other) => peerOf(side, other)?.audio?.srcObject ?? null;

// --- two members ---

// 'pk-m-a' < 'pk-m-b': of two members with a microphone the lower peer ID dials.
const a = member('Laptop', 'pk-m-a');
const b = member('Phone', 'pk-m-b');
link(a, b);
await settle();
check('nobody is in voice to begin with', a.voice.count === 0 && a.voice.mark(b.room.self.peerId) === null);

await a.voice.join();
await settle();
check('joining alone opens the microphone and tells the room',
	a.voice.active && !a.voice.muted && a.voice.stream !== null && b.voice.others.length === 1);
check('but nothing is called while the others are not in voice', callBetween(a, b) === null && b.room.calls.length === 0);

await b.voice.join();
await settle();
check('when the second one joins, exactly one call is made', a.room.calls.length === 1 && b.room.calls.length === 0);
check('and the lower peer ID is the side that dialled', callBetween(a, b)?.answered === false && callBetween(b, a)?.answered === true);
check('both hear the other, over that one call',
	hears(a, b) === b.voice.stream && hears(b, a) === a.voice.stream,
	`${hears(a, b)?.id} / ${hears(b, a)?.id}`);
check('each side counts two in voice', a.voice.count === 2 && b.voice.count === 2);

// Chrome gives a remote stream either to the <audio> element or to Web Audio, never both.
const tapB = peerOf(a, b).level?.owned;
check('the level of another member is read from a copy of the track, so the audio keeps playing',
	Boolean(tapB) && tapB !== hears(a, b) && tapB.getAudioTracks()[0].origin === b.voice.stream.getAudioTracks()[0],
	tapB ? `${tapB.id} vs ${hears(a, b)?.id}` : 'nothing was tapped');
check('this device reads its own microphone straight, because nothing is playing it', taps.includes(a.voice.stream));

loud.add(b.voice.stream.getAudioTracks()[0]);
await sleep(LEVEL_EVERY * 2);
check('a member who speaks is marked, from the copy', a.voice.mark(b.room.self.peerId) === 'speaking');
loud.clear();
await sleep(SPEAKING_HOLD + LEVEL_EVERY);
check('and stops being marked when it goes quiet', a.voice.mark(b.room.self.peerId) === 'on');
check('and shows the other as unmuted', a.voice.mark(b.room.self.peerId) === 'on' && b.voice.mark(a.room.self.peerId) === 'on');

// --- a call that carries nothing ---

const bTrack = b.voice.stream.getAudioTracks()[0];
bTrack.muted = true;
bTrack.fire('mute');
check('a call that stops carrying media is not someone who can be heard',
	a.voice.mark(b.room.self.peerId) === 'waiting' && a.voice.waiting.length === 1
	&& a.voice.statusOf(peerOf(a, b)) === 'No sound coming through');
bTrack.muted = false;
bTrack.fire('unmute');
check('and is heard again when media comes back, without remaking the call',
	a.voice.mark(b.room.self.peerId) === 'on' && callBetween(a, b)?.closed === false);

// --- mute ---

a.voice.setMuted(true);
await settle();
check('muting stops the track without touching the call',
	a.voice.stream.getAudioTracks()[0].enabled === false && callBetween(a, b)?.closed === false);
check('the others see the mark', b.voice.mark(a.room.self.peerId) === 'muted' && a.voice.selfMark === 'muted');
a.voice.setMuted(false);
await settle();
check('unmuting is the same message back', b.voice.mark(a.room.self.peerId) === 'on' && a.voice.stream.getAudioTracks()[0].enabled === true);

// --- volume and a local mute ---

b.voice.setVolume(a.room.self.deviceId, 0.4);
b.voice.setPeerMuted(a.room.self.deviceId, true);
check('volume and a local mute reach the audio element', peerOf(b, a).audio.volume === 0.4 && peerOf(b, a).audio.muted === true);
check('and are remembered for that device', JSON.parse(store.get('peerkit.voice')).peers['dev-Laptop'].volume === 0.4);
b.voice.setPeerMuted(a.room.self.deviceId, false);

// --- a third member, with no microphone of its own ---

const c = member('Desktop', 'pk-m-c');
link(a, c);
link(b, c);
await settle();
mic.available = false;
const note = await c.voice.join();
mic.available = true;
await settle();
check('a device with no microphone joins as a listener', c.voice.active && c.voice.listening && c.voice.muted && Boolean(note), note);
check('the others show it muted', a.voice.mark(c.room.self.peerId) === 'muted' && b.voice.mark(c.room.self.peerId) === 'muted');
check('a listener is not someone we are waiting to hear', a.voice.waiting.length === 0 && a.voice.statusOf(peerOf(a, c)) === 'Listening only');
check('a listener never dials: the others call it', c.room.calls.length === 0 && a.room.calls.length === 2 && b.room.calls.length === 1);
check('it hears both of them', hears(c, a) === a.voice.stream && hears(c, b) === b.voice.stream);
check('and they get no audio from it', hears(a, c) === null && hears(b, c) === null);
check('every pair has exactly one call',
	[[a, b], [a, c], [b, c]].every(([x, y]) => callBetween(x, y) && callBetween(y, x) && callBetween(x, y).answered !== callBetween(y, x).answered));

// --- a call that connects but never carries audio ---

check('a call that has brought audio is not waited for any more', peerOf(a, b).watch === null && peerOf(b, a).watch === null);
check('and a listener is never waited for: it has nothing to send back', peerOf(a, c).watch === null);
const stalled = callBetween(a, b);
const warn = console.warn;
console.warn = () => {};
a.voice.stalled(peerOf(a, b), stalled);
await settle();
console.warn = warn;
check('a call that brought no audio is given up on', stalled.closed === true && callBetween(a, b) === null);
await sleep(REDIAL_DELAY + 100);
check('and the pair is dialled again, so silence is not forever',
	callBetween(a, b)?.closed === false && hears(a, b) === b.voice.stream && hears(b, a) === a.voice.stream);

// --- a link that drops and comes back after a reload ---

const callBefore = callBetween(a, b);
const tapA = peerOf(b, a).level?.owned;
unlink(a, b);
await settle();
check('a dropped link closes that call and forgets the member', callBefore.closed === true && !peerOf(a, b) && a.voice.count === 2);
check('the copy that was reading the level is stopped, the microphone it copied is not',
	tapA?.getAudioTracks()[0].readyState === 'ended' && a.voice.stream.getAudioTracks()[0].readyState === 'live');
check('the members still linked keep talking', hears(c, a) === a.voice.stream && hears(c, b) === b.voice.stream);

// A reload drops every link and comes back with a new peer ID.
unlink(b, c);
b.room.self.peerId = 'pk-m-b2';
link(a, b);
link(b, c);
await settle();
check('when it is back, voice picks up by itself', callBetween(a, b)?.closed === false && hears(a, b) === b.voice.stream && hears(b, a) === a.voice.stream);

// --- calls that are not ours ---

const camera = new FakeMediaConnection(holder(), a.room.self.peerId, { kind: 'camera', id: 'x1' }, new FakeMediaStream(['video', 'audio']));
a.room.emit('call', camera, { ...b.room.self });
await settle();
check('a camera call is left to the Stream tool', camera.answered === false && camera.closed === false);

const d = member('Tablet', 'pk-m-d');
link(a, d);
await settle();
const uninvited = new FakeMediaConnection(holder(), d.room.self.peerId, { kind: 'voice' }, new FakeMediaStream(['audio']));
uninvited.other = new FakeMediaConnection(holder(), a.room.self.peerId, { kind: 'voice' }, null);
d.room.emit('call', uninvited, { ...a.room.self });
await settle();
check('a voice call to someone who has not joined voice is refused', uninvited.closed === true && d.voice.peers.get(a.room.self.peerId)?.audio == null);

// --- leaving ---

const track = a.voice.stream.getAudioTracks()[0];
const callToC = callBetween(a, c);
a.voice.leave();
await settle();
check('leaving stops the microphone and closes the calls', track.readyState === 'ended' && callToC.closed === true && a.voice.stream === null);
check('the others drop the mark and the audio', c.voice.mark(a.room.self.peerId) === null && hears(c, a) === null);
check('and those who stay keep hearing each other', hears(c, b) === b.voice.stream && b.voice.mark(c.room.self.peerId) === 'muted');

// --- the signaling server was away when the pair should have called ---

const e = member('Kitchen', 'pk-m-e');
const f = member('Studio', 'pk-m-f');
link(e, f);
e.room.offline = f.room.offline = true;
await e.voice.join();
await f.voice.join();
await settle();
check('a call cannot be made while the signaling server is away', callBetween(e, f) === null && e.voice.count === 2);
check('and the member is marked as one we cannot hear yet, not as connected',
	e.voice.mark(f.room.self.peerId) === 'waiting' && e.voice.waiting.length === 1 && e.voice.statusOf(peerOf(e, f)) === 'No call yet');
e.room.offline = f.room.offline = false;
e.room.emit('state', 'open');
await settle();
check('when it comes back the pair calls by itself, without rejoining voice',
	hears(e, f) === f.voice.stream && hears(f, e) === e.voice.stream);
check('and only then does it count as someone who can be heard',
	e.voice.mark(f.room.self.peerId) === 'on' && e.voice.waiting.length === 0 && e.voice.statusOf(peerOf(e, f)) === null);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
