// The Stream tool in jsdom, on the fake peerjs network, with real rooms: a screen and a camera sent to the whole
// room at once, a newcomer getting the streams already running, a viewer closing one (the others keep it) and
// watching it again, a camera switch reaching every viewer, a phone's camera going down to 480p for a crowd, the
// upload warning and each viewer's bitrate cap, a link that drops and comes back, the sender leaving, Stop,
// forged messages and calls, and the resume offer after a reload. Media calls run on FakeRTCPeerConnection.
const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, ''); // the repo root
const { JSDOM, VirtualConsole } = await import('jsdom');

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', err => {
	if (!/Not implemented: (navigation|HTMLMediaElement)/.test(err.message)) errors.push(`jsdom: ${err.message}`);
});
const dom = new JSDOM('<!doctype html><html><body><div class="app"></div><div id="toasts"></div></body></html>', {
	url: 'https://peerkit.test/',
	pretendToBeVisual: true,
	virtualConsole,
});
const { window } = dom;
const origError = console.error;
console.error = (...args) => {
	errors.push(args.map(String).join(' '));
	origError(...args);
};
process.on('unhandledRejection', err => errors.push(`unhandled rejection: ${err?.stack ?? err}`));
window.addEventListener('error', e => errors.push(`window error: ${e.message}`));
const warnings = [];
console.warn = (...args) => warnings.push(args.map(String).join(' '));

const expose = ['window', 'Window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history',
	'HTMLElement', 'HTMLDialogElement', 'Element', 'Node', 'Text', 'DocumentFragment', 'MutationObserver', 'getComputedStyle',
	'requestAnimationFrame', 'cancelAnimationFrame', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'DOMParser'];
for (const key of expose) Object.defineProperty(globalThis, key, { value: key === 'window' ? window : window[key], configurable: true, writable: true });
let coarsePointer = false; // a phone's touch screen, for the camera that goes down to 480p
window.matchMedia = globalThis.matchMedia = query => ({ matches: query.includes('coarse') && coarsePointer, addEventListener() {}, removeEventListener() {} });
window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
window.HTMLDialogElement.prototype.close = function () {
	if (!this.hasAttribute('open')) return;
	this.removeAttribute('open');
	this.dispatchEvent(new window.Event('close'));
};
window.HTMLMediaElement.prototype.play = function () {
	this.playing = true;
	return Promise.resolve();
};
Object.defineProperty(window.HTMLMediaElement.prototype, 'paused', { get() { return !this.playing; }, configurable: true });

const { FakeMediaStream, FakePeer, FakeRTCPeerConnection, FakeTrack, rtc } = await import('./fakenet.mjs');
globalThis.Peer = window.Peer = FakePeer;
globalThis.RTCPeerConnection = window.RTCPeerConnection = FakeRTCPeerConnection;

// What the devices capture: every track starts muted, as a remote one does until its first frame.
const captured = [];
function track(kind, settings = {}) {
	const t = new FakeTrack(kind, settings);
	t.muted = true;
	captured.push(t);
	return t;
}
Object.defineProperty(window.navigator, 'mediaDevices', {
	value: {
		async getUserMedia({ video, audio } = {}) {
			const deviceId = video?.deviceId?.exact ?? 'cam-front';
			return new FakeMediaStream([video && track('video', { deviceId }), audio && track('audio')].filter(Boolean));
		},
		async getDisplayMedia() {
			return new FakeMediaStream([track('video', { displaySurface: 'monitor' }), track('audio')]);
		},
		async enumerateDevices() {
			return [{ kind: 'videoinput', deviceId: 'cam-front' }, { kind: 'videoinput', deviceId: 'cam-back' }, { kind: 'audioinput', deviceId: 'mic' }];
		},
	},
	configurable: true,
});

// The Stream tool's own timers (the 30 s a viewer waits for a sender, the 2 s between upload samples) run 20× faster here.
const fromStream = () => /\/app\/tools\/stream\.js/.test(new Error().stack);
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms >= 1000 && fromStream() ? ms / 20 : ms, ...args);
globalThis.setInterval = (fn, ms, ...args) => realSetInterval(fn, ms >= 1000 && fromStream() ? ms / 20 : ms, ...args);

const { Room } = await import(`${ROOT}/app/room.js`);
const { Emitter } = await import(`${ROOT}/app/emitter.js`);
const { newRoomCode } = await import(`${ROOT}/app/rooms.js`);
const { CH } = await import(`${ROOT}/app/protocol.js`);
const { wakeLock } = await import(`${ROOT}/app/util.js`);
const { default: stream } = await import(`${ROOT}/app/tools/stream.js`);

const sleep = ms => new Promise(resolve => realSetTimeout(resolve, ms));
let failures = 0;
function check(name, ok, extra = '') {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
	if (!ok) failures++;
}
async function until(name, fn, ms = 5000, show = () => '') {
	const start = Date.now();
	for (;;) {
		let value;
		try {
			value = fn();
		} catch {
			value = false;
		}
		if (value) return check(name, true, `${Date.now() - start} ms`);
		if (Date.now() - start > ms) return check(name, false, `timed out ${show()}`);
		await sleep(10);
	}
}
const buttonByText = (root, text) => [...(root?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim() === text);
const byLabel = (root, label) => root?.querySelector(`[aria-label="${label}"]`);

// --- devices: a room each, with the Stream tool ---

const code = newRoomCode();
const ice = () => ({ forRoom: null, adopt: () => false });

function device(name, letter) {
	const identity = Object.assign(new Emitter(), { id: letter.repeat(16), name });
	const room = new Room({ code, ice: ice(), identity });
	room.start();
	return mountOn({ name, letter, room });
}

function mountOn(dev) {
	const voice = new Emitter();
	dev.voice = false;
	dev.root = document.createElement('section');
	document.querySelector('.app').append(dev.root);
	dev.activated = 0;
	dev.ctx = {
		room: dev.letter.repeat(32),
		activate: () => dev.activated++,
		notify() {},
		visible: () => true,
		voiceActive: () => dev.voice,
		onVoiceChange: fn => voice.on('change', fn),
	};
	dev.setVoice = on => {
		dev.voice = on;
		voice.emit('change');
	};
	dev.unmount = stream.mount(dev.root, dev.room, dev.ctx);
	return dev;
}

const tiles = dev => [...dev.root.querySelectorAll('.stream-grid .tile')];
const tileOf = (dev, title) => tiles(dev).find(tile => tile.querySelector('.tile-label').textContent === title);
const playing = (dev, title) => {
	const tile = tileOf(dev, title);
	return Boolean(tile) && !tile.querySelector('.remote').hidden && tile.querySelector('.stage-message').hidden;
};
const says = (dev, title) => tileOf(dev, title)?.querySelector('.stage-message:not([hidden])')?.textContent ?? '';
const status = (dev, kind) => dev.root.querySelector(`.stream-out[data-kind="${kind}"] .live`)?.textContent ?? '';
const linked = (...devs) => devs.every(dev => dev.room.members.length === devs.length - 1);
/** The calls a device sends its `kind` over: the RTCPeerConnections holding its captured track. */
const pcsWith = t => rtc.made.filter(pc => !pc.closed && pc.senders.some(sender => sender.track === t));

const L = device('Laptop', 'a');
const P = device('Phone', 'b');
const T = device('Tablet', 'c');
await until('three devices in the room', () => linked(L, P, T), 8000);
check('nothing to watch yet: the stage invites to share', L.root.querySelector('.stream > .stage > .stage-message')?.textContent.includes('Share your camera or screen with the room'));
check('Share camera and Share screen, with no picker to choose one member', Boolean(buttonByText(L.root, 'Share camera')) && Boolean(buttonByText(L.root, 'Share screen')));

// --- the laptop shares its screen: everyone gets it ---

buttonByText(L.root, 'Share screen').click();
await until('the laptop’s screen reaches both others, connecting until the first frame', () =>
	says(P, 'Laptop’s screen').includes('Connecting to Laptop’s screen') && says(T, 'Laptop’s screen').includes('Connecting to Laptop’s screen'));
check('the Stream tab comes to the front for it on a phone', P.activated === 1 && T.activated === 1);
const screenVideo = captured.find(t => t.kind === 'video' && t.settings.displaySurface);
screenVideo.muted = false;
screenVideo.fire('unmute');
await until('the first frame shows it on both', () => playing(P, 'Laptop’s screen') && playing(T, 'Laptop’s screen'));
await until('the laptop counts two watching', () => status(L, 'screen').startsWith('Sharing your screen · 2 watching'), 3000, () => status(L, 'screen'));
check('one call per viewer', pcsWith(screenVideo).length === 2);
check('with its own preview filling the stage', !L.root.querySelector('.previews').hidden && !L.root.querySelector('.stream').classList.contains('has-remote'));
check('and a camera can still be started beside it', Boolean(buttonByText(L.root, 'Share camera')) && !buttonByText(L.root, 'Share screen'));

// Sound: the screen carries audio; a tap turns it on for every stream.
const soundBtn = tileOf(P, 'Laptop’s screen').querySelector('.sound-btn');
check('a stream with sound offers Tap for sound', !soundBtn.hidden && tileOf(P, 'Laptop’s screen').querySelector('.remote').muted);
soundBtn.click();
check('which unmutes it and turns into Mute', !tileOf(P, 'Laptop’s screen').querySelector('.remote').muted && Boolean(byLabel(tileOf(P, 'Laptop’s screen'), 'Mute')));
byLabel(tileOf(P, 'Laptop’s screen'), 'Mute').click();
check('Mute silences that stream alone', tileOf(P, 'Laptop’s screen').querySelector('.remote').muted && Boolean(byLabel(tileOf(P, 'Laptop’s screen'), 'Unmute')));
byLabel(tileOf(P, 'Laptop’s screen'), 'Unmute').click();

// --- the phone shares its camera at the same time ---

buttonByText(P.root, 'Share camera').click();
await until('the phone’s camera reaches the laptop and the tablet', () => tileOf(L, 'Phone’s camera') && tileOf(T, 'Phone’s camera'));
const phoneVideo = captured.filter(t => t.kind === 'video' && t.settings.deviceId === 'cam-front').at(-1);
phoneVideo.muted = false;
phoneVideo.fire('unmute');
await until('everyone sees both streams', () => playing(L, 'Phone’s camera') && playing(T, 'Phone’s camera') && playing(T, 'Laptop’s screen') && playing(P, 'Laptop’s screen'));
check('the tablet has two tiles in its grid', tiles(T).length === 2);
check('the laptop sees the camera with its own preview small in a corner', tiles(L).length === 1 && L.root.querySelector('.stream').classList.contains('has-remote') && !L.root.querySelector('.previews').hidden);
check('and the phone sees the screen while it sends its camera', tiles(P).length === 1 && P.root.querySelectorAll('.previews video').length === 1);
check('the phone’s bar has its camera controls', Boolean(byLabel(P.root, 'Resolution')) && Boolean(byLabel(P.root, 'Mute microphone')) && Boolean(buttonByText(P.root.querySelector('.stream-out[data-kind="camera"]'), 'Stop')));
// Tap to focus on the tablet, and back.
tileOf(T, 'Phone’s camera').querySelector('.remote').click();
check('a tap on a stream shows it large', T.root.querySelector('.stream-grid').classList.contains('focused') && tileOf(T, 'Phone’s camera').classList.contains('focus'));
tileOf(T, 'Phone’s camera').querySelector('.remote').click();
check('and a second tap goes back to the grid', !T.root.querySelector('.stream-grid').classList.contains('focused') && !tileOf(T, 'Phone’s camera').classList.contains('focus'));

// Voice owns the microphone while it is on.
const phoneMic = captured.filter(t => t.kind === 'audio').at(-1);
check('the camera sends the microphone', phoneMic.enabled);
P.setVoice(true);
check('joining voice turns it off in the camera stream', !phoneMic.enabled && byLabel(P.root, 'Your microphone goes through the room’s voice')?.disabled);
P.setVoice(false);
check('and leaving voice turns it back on', phoneMic.enabled);

// --- a newcomer gets the streams already running ---

coarsePointer = true; // the phone is a phone: a crowd makes its camera go down to 480p
const D = device('Desk', 'd');
await until('a device that joins later sees both streams within seconds', () => playing(D, 'Laptop’s screen') && playing(D, 'Phone’s camera'), 8000);
await until('the senders count three watching', () => status(L, 'screen').startsWith('Sharing your screen · 3 watching') && status(P, 'camera').startsWith('Sharing your camera · 3 watching'), 3000);
check('the newcomer’s Stream tab comes to the front', D.activated >= 1);
await until('with three viewers the phone’s camera goes down to 480p', () => phoneVideo.constraints?.width?.ideal === 854);
check('the resolution menu keeps the choice and says why', byLabel(P.root, 'Resolution').value === '720p' && byLabel(P.root, 'Resolution').title === '480p while more than 2 watch');

// --- a viewer closes a stream: the others keep it ---

byLabel(tileOf(D, 'Phone’s camera'), 'Close Phone’s camera').click();
await until('the viewer that closed it stops getting it', () => !tileOf(D, 'Phone’s camera') && status(P, 'camera').startsWith('Sharing your camera · 2 watching'));
check('the others keep it', playing(L, 'Phone’s camera') && playing(T, 'Phone’s camera'));
check('the closed stream waits as a chip', Boolean(buttonByText(D.root.querySelector('.stream-closed'), 'Watch Phone’s camera')) && !D.root.querySelector('.stream-closed').hidden);
await until('two viewers again: the phone’s camera goes back to 720p', () => phoneVideo.constraints?.width?.ideal === 1280);
buttonByText(D.root.querySelector('.stream-closed'), 'Watch Phone’s camera').click();
await until('Watch brings it back', () => playing(D, 'Phone’s camera') && status(P, 'camera').startsWith('Sharing your camera · 3 watching') && D.root.querySelector('.stream-closed').hidden);

// --- the phone switches camera: every viewer gets the new one, with no new call ---

const callsBefore = pcsWith(phoneVideo);
await until('two cameras: Switch camera is offered', () => Boolean(byLabel(P.root, 'Switch camera')));
byLabel(P.root, 'Switch camera').click();
await until('the switch reaches every viewer’s call', () => {
	const next = captured.filter(t => t.kind === 'video' && t.settings.deviceId === 'cam-back').at(-1);
	return next && pcsWith(next).length === 3 && callsBefore.every(pc => pcsWith(next).includes(pc));
});
check('the old camera is off', phoneVideo.readyState === 'ended');
check('and every viewer still plays it', playing(L, 'Phone’s camera') && playing(T, 'Phone’s camera') && playing(D, 'Phone’s camera'));

// --- the upload can't keep up with one viewer: a warning, and that viewer's cap goes down, then up again ---

const tabletPeer = L.room.members.find(member => member.name === 'Tablet').peerId;
const toTablet = () => [...L.room.calls.values()].find(call => call.peer === tabletPeer && call.metadata?.kind === 'screen')?.peerConnection;
let squeezed = true;
const sent = new Map();
rtc.stats = (pc, sender) => {
	// About 1 Mbit/s of video at the sample rate here; the call to the tablet is held back by bandwidth.
	const bytes = (sent.get(sender) ?? 0) + 6250;
	sent.set(sender, bytes);
	return { bytesSent: bytes, qualityLimitationReason: sender.track?.kind === 'video' && squeezed && pc === toTablet() ? 'bandwidth' : 'none' };
};
await until('the sender is warned that its upload can’t keep up', () => L.root.querySelector('.stream-out[data-kind="screen"] .stream-warn:not([hidden])')?.textContent.includes('upload can’t keep up'));
const capOf = pc => pc?.senders.find(sender => sender.track?.kind === 'video')?.params.encodings[0].maxBitrate;
await until('that viewer’s bitrate is capped below what it gets through', () => capOf(toTablet()) >= 150000 && capOf(toTablet()) < 1500000, 3000, () => capOf(toTablet()));
check('the others are left alone', pcsWith(screenVideo).filter(pc => pc !== toTablet()).every(pc => capOf(pc) === undefined));
await until('the bar shows the upload rate', () => /· \d+(\.\d)? (Mbit|kbit)\/s$/.test(status(L, 'screen')), 3000, () => status(L, 'screen'));
squeezed = false;
await until('once it is calm the warning goes', () => L.root.querySelector('.stream-out[data-kind="screen"] .stream-warn').hidden);
await until('and the cap rises until it is taken off', () => toTablet() && capOf(toTablet()) === undefined, 10000, () => capOf(toTablet()));
rtc.stats = () => ({});

// --- a link drops and comes back ---

const ctlBetween = (a, b) => [...a.room.peer.conns].find(conn => conn.label === 'ctl' && conn.peer === b.room.peer.id);
ctlBetween(L, T).close();
await until('the tablet pauses the laptop’s screen while the link is down', () => says(T, 'Laptop’s screen').includes('Paused until the connection comes back'), 3000);
await until('and plays it again when the link is back, the same stream', () => playing(T, 'Laptop’s screen') && tiles(T).filter(tile => tile.querySelector('.tile-label').textContent === 'Laptop’s screen').length === 1, 8000);
await until('the laptop counts the tablet again', () => status(L, 'screen').startsWith('Sharing your screen · 3 watching'), 3000);

// A stream closed before a drop stays closed after it: the sender forgets, the viewer says it again.
byLabel(tileOf(T, 'Phone’s camera'), 'Close Phone’s camera').click();
await until('(the tablet closes the phone’s camera)', () => status(P, 'camera').startsWith('Sharing your camera · 2 watching'));
ctlBetween(P, T).close();
await until('(the link between them drops)', () => !P.room.members.some(member => member.name === 'Tablet'), 3000);
await until('(and comes back)', () => P.room.members.some(member => member.name === 'Tablet') && T.room.members.some(member => member.name === 'Phone'), 8000);
await sleep(200);
check('the stream the tablet closed stays closed', !tileOf(T, 'Phone’s camera') && Boolean(buttonByText(T.root.querySelector('.stream-closed'), 'Watch Phone’s camera')));
await until('and the phone doesn’t count it', () => status(P, 'camera').startsWith('Sharing your camera · 2 watching'), 3000, () => status(P, 'camera'));

// --- forged messages and calls from a member ---

const H = new Room({ code, ice: ice(), identity: { id: 'e'.repeat(16), name: 'Headless' } });
H.start();
await until('(a headless member joins)', () => H.members.length === 4, 8000);
const screenId = tileOf(T, 'Laptop’s screen').dataset.stream;
H.send(CH.STREAM, { type: 'stop', id: screenId });
H.send(CH.STREAM, { type: 'start', id: screenId, kind: 'camera' });
H.send(CH.STREAM, { type: 'start', id: '../x', kind: 'screen' });
H.send(CH.STREAM, { type: 'start', id: { toString: 'x' }, kind: 'screen' });
await sleep(100);
check('another member can’t stop or take over a stream by its id', playing(T, 'Laptop’s screen') && tileOf(T, 'Laptop’s screen').dataset.stream === screenId && !tileOf(T, 'Headless’s camera'));
check('ids that aren’t ids are ignored', tiles(T).length === 1);
const toT = H.members.find(member => member.name === 'Tablet').peerId;
const badCall = H.call(toT, new FakeMediaStream([new FakeTrack('video')]), { id: 'no good', kind: 'screen' });
let badClosed = false;
badCall.on('close', () => (badClosed = true));
await until('a call with a bad id is closed', () => badClosed);
for (let i = 0; i < 20; i++) H.send(CH.STREAM, { type: 'start', id: `f${i}`, kind: 'camera' });
// The tablet has the laptop's screen and the phone's camera (closed): room for 14 more.
await until('at most 16 streams at once, a closed one included', () => T.root.querySelectorAll('.tile').length === 15);
await H.leave();
await until('a sender who leaves: its streams pause, then end', () => says(T, 'Headless’s camera').includes('ended') || says(T, 'Headless’s camera').includes('Paused'), 3000);
await until('(and end)', () => tiles(T).filter(tile => tile.textContent.includes('Headless’s camera stream ended')).length === 14, 5000);
for (const tile of tiles(T).filter(tile => tile.textContent.includes('Headless'))) buttonByText(tile, 'Close').click();
check('Close takes an ended stream away', tiles(T).length === 1);

// --- the phone leaves: its camera pauses, then ends, for everyone ---

P.unmount();
await P.room.leave();
await until('the phone’s camera pauses for the others', () => says(L, 'Phone’s camera').includes('Paused') || says(L, 'Phone’s camera').includes('ended'), 3000);
await until('and ends when it doesn’t come back', () => says(L, 'Phone’s camera').includes('Phone’s camera stream ended') && says(D, 'Phone’s camera').includes('Phone’s camera stream ended'), 5000);
await until('the tablet forgets the one it had closed', () => T.root.querySelector('.stream-closed').hidden, 5000);

// --- Stop: every viewer is told ---

buttonByText(L.root.querySelector('.stream-out[data-kind="screen"]'), 'Stop').click();
await until('Stop ends the screen for every viewer', () => says(T, 'Laptop’s screen').includes('Laptop’s screen sharing ended') && says(D, 'Laptop’s screen').includes('Laptop’s screen sharing ended'));
check('its calls are closed', pcsWith(screenVideo).length === 0 && screenVideo.readyState === 'ended');
check('and the laptop can share again', Boolean(buttonByText(L.root, 'Share screen')) && L.root.querySelector('.previews').hidden);
for (const dev of [L, T, D]) for (const tile of tiles(dev)) buttonByText(tile, 'Close')?.click();
check('nothing on the stages once they are closed', [L, T, D].every(dev => !tiles(dev).length));

// --- a reload while sharing offers to resume ---

buttonByText(L.root, 'Share camera').click();
await until('(the laptop shares its camera)', () => status(L, 'camera').startsWith('Sharing your camera'));
L.unmount();
check('the tool going away ends the capture', captured.filter(t => t.kind === 'video' && t.settings.deviceId === 'cam-front').at(-1).readyState === 'ended');
await until('the viewers are told', () => says(T, 'Laptop’s camera').includes('ended'));
mountOn(L);
check('after a reload the tab offers to resume what it shared', L.root.querySelector('.stream-resume:not([hidden])')?.textContent.includes('Your camera stopped when the page reloaded') && Boolean(buttonByText(L.root.querySelector('.stream-resume'), 'Resume')));
buttonByText(L.root.querySelector('.stream-resume'), 'Resume').click();
await until('Resume shares it with the room again', () => status(L, 'camera').startsWith('Sharing your camera · 2 watching') && L.root.querySelector('.stream-resume').hidden, 3000);
buttonByText(L.root, 'Stop').click();
for (const dev of [T, D]) {
	await until(`(${dev.name} is told)`, () => tiles(dev).every(tile => tile.textContent.includes('ended')));
	for (const tile of tiles(dev)) buttonByText(tile, 'Close')?.click();
}

check('every wake lock is let go', wakeLock.count === 0, `count ${wakeLock.count}`);
for (const dev of [L, T, D]) dev.unmount();
for (const dev of [L, T, D]) await dev.room.leave();

await sleep(50);
check('no errors logged', errors.length === 0, errors.slice(0, 3).join(' | '));
const unexpected = warnings.filter(w => !/peer error|media call/.test(w));
check('no unexpected warnings', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
