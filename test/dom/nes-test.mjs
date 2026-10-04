// The NES tool in jsdom, on the fake peerjs network, with the real FCEUX build (vendor/fceux/) running a tiny ROM
// made here: it counts frames in its NMI and reads all four pads (Four Score) into RAM, where this test reads what
// the game sees. A laptop runs the game; a phone plays it as a pad and a tablet with the picture streamed to it.
// Checked: the NES rate on 60, 120 and 144 Hz screens, the laptop's keys (and a tap shorter than a frame), the
// phone and the tablet on players 2 and 3, swapping players, a pad that goes away pausing the game until it's
// back, Pause, save slots, export and import, Reset, Stop unloading the emulator, Continue from IndexedDB, the host
// playing on its own touch screen with the pad over its picture, and the small pieces (the Standard Gamepad
// mapping, seats, keys, the messages, ROM and save checks).
import { readFileSync } from 'node:fs';

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
	runScripts: 'outside-only', // the emulator's iframe runs its script with eval
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
console.warn = () => {};

const expose = ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history', 'screen',
	'HTMLElement', 'Element', 'Node', 'Text', 'DocumentFragment', 'MutationObserver', 'getComputedStyle',
	'requestAnimationFrame', 'cancelAnimationFrame', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'DOMParser', 'File', 'Blob'];
for (const key of expose) Object.defineProperty(globalThis, key, { value: key === 'window' ? window : window[key], configurable: true, writable: true });
let coarsePointer = false;
window.matchMedia = globalThis.matchMedia = query => ({ matches: query.includes('coarse') && coarsePointer, addEventListener() {}, removeEventListener() {} });
document.documentElement.requestFullscreen = async () => {};
window.navigator.vibrate = () => true;
window.navigator.getGamepads = () => [null, null, null, null];
window.HTMLMediaElement.prototype.play = async function play() {
	this.playing = true;
};
const downloads = [];
window.URL.createObjectURL = globalThis.URL.createObjectURL = blob => {
	downloads.push(blob);
	return `blob:${downloads.length}`;
};
window.URL.revokeObjectURL = globalThis.URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = () => {};
window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
window.HTMLDialogElement.prototype.close = function () {
	if (!this.hasAttribute('open')) return;
	this.removeAttribute('open');
	this.dispatchEvent(new window.Event('close'));
};

const { FakeMediaStream, FakePeer, FakeRTCPeerConnection, FakeTrack } = await import('./fakenet.mjs');
globalThis.Peer = window.Peer = FakePeer;
globalThis.RTCPeerConnection = window.RTCPeerConnection = FakeRTCPeerConnection;
globalThis.MediaStream = window.MediaStream = FakeMediaStream;
await import('fake-indexeddb/auto');
for (const key of Object.getOwnPropertyNames(window).filter(k => /^(indexedDB|IDB)/.test(k))) {
	Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}

const { Room } = await import(`${ROOT}/app/room.js`);
const { Emitter } = await import(`${ROOT}/app/emitter.js`);
const { newRoomCode } = await import(`${ROOT}/app/rooms.js`);
const { wakeLock } = await import(`${ROOT}/app/util.js`);
const { default: nes, readGame, readPlayers } = await import(`${ROOT}/app/tools/nes/nes.js`);
const { InputHub } = await import(`${ROOT}/app/tools/controller/input.js`);
const { Pacer, NES_FPS, nesFiles, romKind, isState } = await import(`${ROOT}/app/tools/nes/emulator.js`);
const { NES, Seats, nesBits, readKeys, keyLabel } = await import(`${ROOT}/app/tools/nes/players.js`);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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
const toasts = () => document.getElementById('toasts').textContent;

// --- the small pieces ---

const run = (fps, seconds) => {
	const pacer = new Pacer();
	let frames = 0;
	for (let t = 0; t < seconds * 1000; t += 1000 / fps) frames += pacer.due(t);
	return frames;
};
for (const hz of [60, 120, 144, 50]) {
	const frames = run(hz, 10);
	check(`on a ${hz} Hz screen the game runs at the NES rate (${Math.round(NES_FPS * 10)} frames in 10 s)`, Math.abs(frames - NES_FPS * 10) <= 2, `${frames}`);
}
{
	const pacer = new Pacer();
	pacer.due(0);
	pacer.due(16.6);
	check('after a stall (a hidden page) it goes on with one frame, not a burst', pacer.due(5000) === 1);
	pacer.reset();
	let most = 0;
	for (let t = 0; t < 2000; t += 40) most = Math.max(most, pacer.due(t)); // a slow device at 25 Hz
	check('and a slow screen runs at most two frames at a time', most === 2);
}

check('NES A is the right face button (standard 1), B the bottom one (0)', nesBits(1 << 1) === NES.A && nesBits(1 << 0) === NES.B);
check('Select, Start and the D-pad map across', nesBits((1 << 8) | (1 << 9) | (1 << 12) | (1 << 15)) === (NES.Select | NES.Start | NES.Up | NES.Right));
check('a stick pushed past half way is the D-pad', nesBits(0, [-0.8, 0.9]) === (NES.Left | NES.Down) && nesBits(0, [0.3, -0.4]) === 0);

{
	const seats = new Seats();
	check('this device is Player 1', seats.seats[0] === 'host');
	check('a pad that arrives takes the first free seat', seats.arrive('pad:0') === 1 && seats.arrive('pad:2') === 2);
	seats.assign(0, 'pad:2');
	check('choosing a player on another seat swaps the two', seats.seats[0] === 'pad:2' && seats.seats[2] === 'host');
	seats.assign(1, null);
	check('one moved off its seat stays off when it comes back', seats.arrive('pad:0') === -1 && seats.seats[1] === null);
	seats.assign(3, 'nonsense');
	check('a seat takes only a real source', seats.seats[3] === null);
}

check('keys come back from storage, with the default for anything odd', readKeys({ A: 'KeyK', B: '<b>', Start: 7 }).A === 'KeyK' && readKeys({ B: '<b>' }).B === 'KeyZ' && readKeys(null).Start === 'Enter');
check('keys have names for people', keyLabel('KeyX') === 'X' && keyLabel('ArrowLeft') === '←' && keyLabel('ShiftRight') === 'Shift (Right)');
check('a game message is checked', readGame({ title: ' Zelda\x07 ', paused: true }).title === 'Zelda' && readGame({ title: null }) === null
	&& readGame({ title: 5 }) === undefined && readGame({ title: '  ' }) === undefined && readGame({ title: 'x'.repeat(500) }).title.length === 80);
{
	const players = readPlayers([{ device: 'ab'.repeat(8), pad: 0, name: ' Ann\x07 ', away: true }, { device: '<b>', pad: 0 },
		{ device: 'cd'.repeat(8), pad: 9 }, { device: 'ef'.repeat(8), pad: 2, name: 'x'.repeat(99) }, { device: 'ab'.repeat(8), pad: 0 }]);
	check('a game’s players are checked: four seats, a bad one empty', players.length === 4 && players[0].name === 'Ann' && players[0].away
		&& players[1] === null && players[2] === null && players[3].pad === 2 && players[3].name.length === 40);
	check('and no players at all is four empty seats', readPlayers('nope').every(p => p === null) && readGame({ title: 'G' }).players.length === 4);
}

// The test ROM: NROM, 16 KB, no CHR. "PKNES!" at $20 (to find the RAM), NMI counts frames at $12 and reads 16 bits
// from each port: pads 1 and 3 into $10 and $13, pads 2 and 4 into $11 and $14 (A in bit 7 … Right in bit 0).
function testRom() {
	const prg = new Uint8Array(16384).fill(0xea);
	let pc = 0;
	const emit = (...b) => b.forEach(x => (prg[pc++] = x));
	const at = () => 0xc000 + pc;
	const reset = at();
	emit(0x78, 0xd8, 0xa2, 0xff, 0x9a); // sei cld ldx #$ff txs
	emit(0x2c, 0x02, 0x20, 0x10, 0xfb, 0x2c, 0x02, 0x20, 0x10, 0xfb); // wait for two vblanks
	[0x50, 0x4b, 0x4e, 0x45, 0x53, 0x21].forEach((c, i) => emit(0xa9, c, 0x85, 0x20 + i));
	emit(0xa9, 0x80, 0x8d, 0x00, 0x20); // NMI on
	const loop = at();
	emit(0x4c, loop & 255, loop >> 8);
	const nmi = at();
	emit(0xe6, 0x12); // inc frames
	emit(0xa9, 1, 0x8d, 0x16, 0x40, 0xa9, 0, 0x8d, 0x16, 0x40); // strobe
	for (const [port, zp] of [[0x16, 0x10], [0x16, 0x13], [0x17, 0x11], [0x17, 0x14]]) emit(0xa2, 8, 0xad, port, 0x40, 0x4a, 0x26, zp, 0xca, 0xd0, 0xf7);
	emit(0x40); // rti
	prg.set([nmi & 255, nmi >> 8, reset & 255, reset >> 8, nmi & 255, nmi >> 8], 0x3ffa);
	const rom = new Uint8Array(16 + 16384);
	rom.set([0x4e, 0x45, 0x53, 0x1a, 1, 0]);
	rom.set(prg, 16);
	return rom;
}
const ROM = testRom();
check('a ROM is recognised by its header', romKind(ROM) === 'ines' && romKind(new TextEncoder().encode('hello, this is not a game')) === null);
check('a save state is "FCSX" and not too big', isState(new Uint8Array([70, 67, 83, 88, ...new Array(20).fill(0)])) && !isState(new Uint8Array(30)) && !isState(new Uint8Array([70, 67, 83, 88])));

// --- the emulator: the real build in the iframe, with a 2D canvas, sound and a stream faked ---

const SCRIPT = readFileSync(`${ROOT}/vendor/fceux/fceux.js`, 'utf8');
const WASM = new Uint8Array(readFileSync(`${ROOT}/vendor/fceux/fceux.wasm`));
const audio = []; // every AudioContext the emulator made
let wasmLoads = 0;
nesFiles.frame = null;
nesFiles.bytes = async url => {
	wasmLoads++;
	if (!url.endsWith('/vendor/fceux/fceux.wasm')) throw new Error(url);
	return WASM;
};
nesFiles.run = async (win, url) => {
	if (!url.endsWith('/vendor/fceux/fceux.js')) throw new Error(url);
	const painted = { count: 0 };
	win.HTMLCanvasElement.prototype.getContext = function getContext(kind) {
		if (kind !== '2d') return null;
		this.painted = painted;
		return {
			canvas: this,
			createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
			getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
			putImageData: () => painted.count++,
			drawImage() {}, fillRect() {}, clearRect() {}, save() {}, restore() {}, scale() {}, translate() {},
		};
	};
	win.HTMLCanvasElement.prototype.captureStream = () => new FakeMediaStream([new FakeTrack('video')]);
	const gain = () => ({ gain: { value: 1 }, connect(node) {
		return node;
	} });
	win.AudioContext = class {
		constructor() {
			this.state = 'running';
			this.currentTime = 0;
			this.sampleRate = 48000;
			this.destination = {};
			this.gains = [];
			this.closed = false;
			this.timer = setInterval(() => (this.currentTime += 0.01), 10);
			audio.push(this);
		}
		createGain() {
			const g = gain();
			this.gains.push(g);
			return g;
		}
		createMediaStreamDestination() {
			return { stream: new FakeMediaStream([new FakeTrack('audio')]) };
		}
		createBufferSource() {
			return { connect() {}, start() {} };
		}
		createBuffer(channels, length) {
			return { getChannelData: () => new Float32Array(length), copyToChannel() {} };
		}
		async resume() {
			this.state = 'running';
			this.onstatechange?.();
		}
		async suspend() {
			this.state = 'suspended';
			this.onstatechange?.();
		}
		async close() {
			this.closed = true;
			this.state = 'closed';
			clearInterval(this.timer);
		}
	};
	win.eval(SCRIPT);
};

// --- devices: a room each, with the NES tool ---

const code = newRoomCode();
const ice = () => ({ forRoom: null, adopt: () => false });
function device(name, letter, { phone = false } = {}) {
	const identity = Object.assign(new Emitter(), { id: letter.repeat(16), name });
	const room = new Room({ code, ice: ice(), identity });
	room.start();
	const dev = { name, letter, room, notified: 0, shown: true };
	dev.root = document.createElement('section');
	document.querySelector('.app').append(dev.root);
	dev.ctx = { room: letter.repeat(32), activate() {}, notify: () => dev.notified++, visible: () => dev.shown };
	localStorage.clear();
	coarsePointer = phone;
	dev.unmount = nes.mount(dev.root, room, dev.ctx);
	coarsePointer = false;
	return dev;
}
const linked = (...devs) => devs.every(dev => dev.room.members.length >= devs.length - 1);
const L = device('Laptop', 'a');
const P = device('Phone', 'b', { phone: true });
const T = device('Tablet', 'c', { phone: true });
await until('(the three are linked)', () => linked(L, P, T), 8000);

const gameRow = dev => dev.root.querySelector('.nes-game');
check('nobody runs a game yet: no games in the room', !gameRow(P) && P.root.querySelector('.nes-games').closest('section').hidden);

function open(dev, file) {
	const input = dev.root.querySelector('input[type="file"][accept^=".nes"]');
	Object.defineProperty(input, 'files', { value: [file], configurable: true });
	input.dispatchEvent(new window.Event('change'));
}
open(L, new window.File(['hello, this is not a game'], 'notes.nes'));
await until('a file that isn’t a ROM is refused', () => toasts().includes('isn’t a NES ROM'));

P.shown = false;
open(L, new window.File([ROM], 'Test Game.nes'));
const frameWin = () => L.root.querySelector('iframe.nes-frame')?.contentWindow;
await until('a ROM boots the emulator in its own frame', () => frameWin()?.Module?._setGamePadValue && !L.root.querySelector('.nes-stage').hidden, 15000);
const heap = () => frameWin().HEAPU8;
let base = -1;
const findRam = () => until('(the test ROM is running)', () => {
	const h = heap();
	for (let i = 0; i < h.length - 6; i++) if (h[i] === 0x50 && h[i + 1] === 0x4b && h[i + 2] === 0x4e && h[i + 3] === 0x45 && h[i + 4] === 0x53 && h[i + 5] === 0x21) {
		base = i - 0x20;
		return true;
	}
	return false;
}, 3000);
await findRam();
const ram = addr => heap()[base + addr];
const frames = () => ram(0x12);
const pads = () => [ram(0x10), ram(0x11), ram(0x13), ram(0x14)]; // what the game reads from pads 1–4
const A = 0x80;
const RIGHT = 0x01;
const START = 0x10;
const calls = [];
const spyPads = () => {
	const module = frameWin().Module;
	const realSet = module._setGamePadValue;
	module._setGamePadValue = (pad, button, on) => {
		calls.push([pad, button, on]);
		return realSet(pad, button, on);
	};
};
spyPads();
check('the emulator was loaded once, and wasn’t asked for anything else', wasmLoads === 1);
check('the picture is drawn', frameWin().document.getElementById('canvas').painted?.count > 0);

const f0 = frames();
await sleep(1000);
const perSecond = (frames() - f0 + 256) % 256;
check('the game runs about 60 frames a second', perSecond >= 45 && perSecond <= 70, `${perSecond}`);
check('the screen is kept on while the game runs', wakeLock.count === 1);
check('a laptop without a touch screen gets no Touch pad', buttonByText(L.root, 'Touch pad').hidden);
check('and the sound goes through a volume of its own', audio.length === 1 && audio[0].gains.length >= 2 && audio[0].gains[1].gain.value === 1);

await until('the phone sees the laptop’s game', () => gameRow(P)?.textContent.includes('Test Game') && gameRow(P).textContent.includes('Laptop'));
check('and the tab is marked while it’s out of sight', P.notified === 1);
check('with Controller and Remote play', Boolean(buttonByText(gameRow(P), 'Controller') && buttonByText(gameRow(P), 'Remote play')));
P.shown = true;

// The laptop's keys play Player 1.
const key = (type, code, extra = {}) => window.dispatchEvent(new window.KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...extra }));
key('keydown', 'KeyX');
await until('the laptop’s X is A on pad 1', () => pads()[0] === A);
key('keyup', 'KeyX');
await until('and lets go', () => pads()[0] === 0);
calls.length = 0;
const before = frames();
key('keydown', 'Enter');
key('keyup', 'Enter');
await until('a tap shorter than a frame still reaches the game', () => calls.some(c => c[0] === 0 && c[1] === 3 && c[2] === 0));
check('held for two frames', calls.filter(c => c[1] === 3).map(c => c[2]).join() === '1,0' && (frames() - before + 256) % 256 >= 2);
const input = document.createElement('input');
L.root.append(input);
input.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'KeyX', bubbles: true }));
await sleep(80);
check('typing in a text field doesn’t play', pads()[0] === 0);
input.dispatchEvent(new window.KeyboardEvent('keyup', { code: 'KeyX', bubbles: true }));
input.remove();

// The phone joins as a pad: Player 2.
const padOf = () => [...document.querySelectorAll('.pad-play')].at(-1) ?? null;
function place(pad) {
	const rects = { '.pad-dpad': [0, 0, 200, 200], '[aria-label="Select"]': [300, 300, 380, 336], '[aria-label="Start"]': [400, 300, 480, 336], '[aria-label="B"]': [600, 100, 700, 200], '[aria-label="A"]': [720, 100, 820, 200] };
	for (const [selector, [left, top, right, bottom]] of Object.entries(rects)) {
		const el = pad.querySelector(selector);
		if (el) el.getBoundingClientRect = () => ({ left, top, right, bottom, width: right - left, height: bottom - top });
	}
}
function pointer(el, type, clientX, clientY, pointerId = 1) {
	const e = new window.MouseEvent(type, { clientX, clientY, button: 0, bubbles: true, cancelable: true });
	Object.defineProperties(e, { pointerId: { value: pointerId }, pointerType: { value: 'touch' } });
	el.dispatchEvent(e);
}
const seat = i => L.root.querySelectorAll('.nes-seat select')[i];
buttonByText(gameRow(P), 'Controller').click();
await until('Controller opens the NES pad on the phone', () => Boolean(padOf()?.querySelector('.pad-dpad')));
const ppad = padOf();
place(ppad);
check('its top bar names the game', ppad.querySelector('.pad-host').textContent === 'Laptop · Test Game');
await until('the phone takes Player 2', () => seat(1).value === 'pad:0' && seat(1).selectedOptions[0].textContent === 'Phone');
const chip = (dev, i) => gameRow(dev)?.querySelector(`.nes-player[data-seat="${i}"]`);
const seatBtn = pad => [...pad.querySelectorAll('.pad-top-btn')].find(b => /^(Player \d|Not playing)$/.test(b.textContent));
await until('the room sees who plays: Laptop 1, Phone 2, two free seats', () => chip(T, 0)?.textContent === '1 Laptop' && chip(T, 1)?.textContent === '2 Phone'
	&& chip(T, 2).classList.contains('free') && chip(T, 3).textContent === '4 free');
check('in each member’s colour', chip(T, 1).style.getPropertyValue('--member') === P.room.self.color && chip(T, 0).style.getPropertyValue('--member') === L.room.self.color);
check('the phone’s own seat is marked', chip(P, 1).classList.contains('mine') && !chip(T, 1).classList.contains('mine'));
check('and the laptop’s Players have the colours too', seat(1).closest('.nes-seat').style.getPropertyValue('--member') === P.room.self.color);
await until('the phone’s pad says it is Player 2', () => seatBtn(ppad)?.textContent === 'Player 2');
pointer(ppad.querySelector('.pad-surface'), 'pointerdown', 770, 150, 1);
await until('the phone’s A is A on pad 2', () => pads()[1] === A, 3000, () => pads().join());
pointer(ppad.querySelector('.pad-surface'), 'pointerup', 770, 150, 1);
await until('(and up)', () => pads()[1] === 0);

// The tablet joins with the picture: Player 3.
buttonByText(gameRow(T), 'Remote play').click();
await until('Remote play opens the pad over the game’s picture', () => padOf() !== ppad && padOf()?.querySelector('.pad-picture video'));
const tpad = padOf();
place(tpad);
const video = tpad.querySelector('video');
await until('the laptop streams the game to the tablet, which plays it', () => video.srcObject?.getVideoTracks?.().length === 1 && video.playing);
check('with its sound', video.srcObject.getAudioTracks().length === 1);
await until('the tablet takes Player 3', () => seat(2).value === 'pad:1');
pointer(tpad.querySelector('.pad-surface'), 'pointerdown', 190, 100, 1);
await until('the tablet’s right is Right on pad 3 (Four Score)', () => pads()[2] === RIGHT, 3000, () => pads().join());
pointer(tpad.querySelector('.pad-surface'), 'pointerup', 190, 100, 1);
await until('(up)', () => pads()[2] === 0);

// The tablet picks another seat from its pad.
await until('(the tablet’s pad knows its seat)', () => seatBtn(tpad)?.textContent === 'Player 3');
seatBtn(tpad).click();
const seatsPanel = tpad.querySelector('.pad-seats');
const seatChoice = i => seatsPanel.querySelector(`[data-seat="${i}"]`);
check('the seat button lists the four players over the pad', Boolean(seatsPanel) && seatsPanel.querySelectorAll('button').length === 4 && seatBtn(tpad).getAttribute('aria-expanded') === 'true');
check('taken seats can’t be chosen, the free one can', seatChoice(0).disabled && seatChoice(1).disabled && seatChoice(1).textContent.includes('Phone') && !seatChoice(3).disabled
	&& seatChoice(2).getAttribute('aria-current') === 'true');
seatChoice(3).click();
check('choosing closes the list', !tpad.querySelector('.pad-seats'));
await until('the laptop puts the tablet on Player 4, and Player 3 is free', () => seat(3).value === 'pad:1' && seat(2).value === '');
await until('the tablet’s pad says Player 4', () => seatBtn(tpad).textContent === 'Player 4');
check('the Monitor numbers pads as the game does', InputHub.of(L.room).seats.get(1) === 3 && InputHub.of(L.room).seats.get(0) === 1);
pointer(tpad.querySelector('.pad-surface'), 'pointerdown', 190, 100, 1);
await until('the tablet’s right is Right on pad 4 now', () => pads()[3] === RIGHT && pads()[2] === 0, 3000, () => pads().join());
pointer(tpad.querySelector('.pad-surface'), 'pointerup', 190, 100, 1);
await until('(up again)', () => pads()[3] === 0);
T.room.send('nes', { type: 'seat', seat: 0 }, L.room.self.peerId);
T.room.send('nes', { type: 'seat', seat: 7 }, L.room.self.peerId);
T.room.send('nes', { type: 'seat', seat: '1' }, L.room.self.peerId);
await sleep(150);
check('a seat someone has, or no seat at all, isn’t given', seat(0).value === 'host' && seat(1).value === 'pad:0' && seat(3).value === 'pad:1');

// Swapping: the phone becomes Player 1, the laptop Player 2.
seat(0).value = 'pad:0';
seat(0).dispatchEvent(new window.Event('change'));
check('choosing the phone for Player 1 swaps it with the laptop', seat(0).value === 'pad:0' && seat(1).value === 'host');
pointer(ppad.querySelector('.pad-surface'), 'pointerdown', 440, 318, 2);
key('keydown', 'KeyX');
await until('the phone’s Start is on pad 1 now, the laptop’s A on pad 2', () => pads()[0] === START && pads()[1] === A, 3000, () => pads().join());
pointer(ppad.querySelector('.pad-surface'), 'pointerup', 440, 318, 2);
key('keyup', 'KeyX');
seat(0).value = 'host';
seat(0).dispatchEvent(new window.Event('change'));
check('(and back)', seat(0).value === 'host' && seat(1).value === 'pad:0');

// A player that goes away pauses the game, and it goes on when they're back.
byLabel(ppad, 'Stop').click();
await until('a player that stops pauses the game', () => !L.root.querySelector('.nes-notice').hidden && L.root.querySelector('.nes-notice').textContent.includes('waiting for Phone'));
const stopped = frames();
await sleep(200);
check('the game stands still', frames() === stopped);
check('and the sound is held', audio[0].state === 'suspended');
await until('the others see it paused', () => gameRow(P).textContent.includes('paused') && tpad.querySelector('.pad-host').textContent.includes('paused'));
check('the seat stays the phone’s, marked away', seat(1).value === 'pad:0' && seat(1).selectedOptions[0].textContent === 'Phone (away)');
buttonByText(gameRow(P), 'Controller').click();
await until('back on the pad, the phone has its seat again and the game goes on', () => padOf() !== tpad && seat(1).selectedOptions[0].textContent === 'Phone' && L.root.querySelector('.nes-notice').hidden && frames() !== stopped);
const ppad2 = padOf();
place(ppad2);

// Pause by hand.
buttonByText(L.root, 'Pause').click();
const held = frames();
await sleep(150);
check('Pause stops the game', frames() === held && Boolean(buttonByText(L.root, 'Resume')));
await until('and the pads say so', () => ppad2.querySelector('.pad-host').textContent === 'Laptop · Test Game · paused');
L.root.querySelector('.nes-notice').click();
await until('a tap on the picture goes on', () => frames() !== held && Boolean(buttonByText(L.root, 'Pause')));

// Mute.
buttonByText(L.root, 'Mute').click();
check('Mute turns the game’s volume down, not the stream', audio[0].gains[1].gain.value === 0 && Boolean(buttonByText(L.root, 'Unmute')));
buttonByText(L.root, 'Unmute').click();

// Keys.
buttonByText(L.root, 'Keys…').click();
const dialog = document.querySelector('dialog');
dialog.querySelector('[data-button="A"]').click();
check('Keys asks for a key', dialog.querySelector('[data-button="A"]').textContent === 'Press a key…');
key('keydown', 'KeyK');
check('and takes the one pressed', dialog.querySelector('[data-button="A"]').textContent === 'K');
dialog.close();
key('keydown', 'KeyK');
await until('K is A now', () => pads()[0] === A);
key('keyup', 'KeyK');
check('and remembered', JSON.parse(localStorage.getItem('peerkit.nes')).keys.A === 'KeyK');

// Saves.
const saveRow = slot => L.root.querySelector(`.nes-save[data-slot="${slot}"]`);
await until('three save slots, empty', () => saveRow(3) && saveRow(1).textContent.includes('empty') && buttonByText(saveRow(1), 'Load').disabled, 5000, () => L.root.querySelector('.nes-saves').outerHTML.slice(0, 300));
const savedAt = frames();
buttonByText(saveRow(1), 'Save').click();
await until('Save keeps the moment in slot 1', () => toasts().includes('Saved in slot 1') && saveRow(1).textContent.includes('just now'));
await sleep(300);
check('(the game went on)', (frames() - savedAt + 256) % 256 > 10);
buttonByText(saveRow(1), 'Load').click();
await until('Load goes back to it', () => toasts().includes('Slot 1 loaded') && (frames() - savedAt + 256) % 256 < 8, 2000, () => `${savedAt} → ${frames()}`);
buttonByText(L.root, 'Export').click();
const exported = downloads.at(-1);
check('Export downloads the save', exported instanceof window.Blob && exported.size > 100);
const importInput = L.root.querySelector('input[accept=".fcs,.frz"]');
const importFile = file => {
	Object.defineProperty(importInput, 'files', { value: [file], configurable: true });
	importInput.dispatchEvent(new window.Event('change'));
};
importFile(new window.File(['not a save'], 'x.fcs'));
await until('Import refuses a file that isn’t a save', () => toasts().includes('isn’t an FCEUX save state'));
const exportedAt = savedAt; // the export was made right after loading slot 1
await sleep(300);
importFile(new window.File([exported], 'Test Game.fcs'));
await until('and loads one that is', () => toasts().includes('Save loaded') && (frames() - exportedAt + 256) % 256 < 30);

// Reset boots the ROM again; the tablet gets the new picture.
const oldFrame = L.root.querySelector('iframe.nes-frame');
const oldStream = video.srcObject;
buttonByText(L.root, 'Reset').click();
await until('Reset starts the game again in a new frame', () => L.root.querySelector('iframe.nes-frame') && L.root.querySelector('iframe.nes-frame') !== oldFrame && frameWin().Module?._setGamePadValue, 15000);
check('the old one is gone, its sound closed', !oldFrame.isConnected && audio[0].closed);
await until('the tablet gets the new picture', () => video.srcObject && video.srcObject !== oldStream);
check('players stay', seat(1).value === 'pad:0' && seat(3).value === 'pad:1');

// Stop: the emulator unloads, the guests are told.
const locks = wakeLock.count; // the game's and the two pads' (one process here, three devices)
buttonByText(L.root, 'Stop').click();
check('Stop unloads the emulator', !L.root.querySelector('iframe.nes-frame') && audio.every(ctx => ctx.closed));
check('and lets the screen sleep', wakeLock.count === locks - 1, `${locks} → ${wakeLock.count}`);
await until('the pads stop, saying why', () => !padOf() && toasts().includes('Laptop stopped the game'));
check('and the game is gone from their lists', !gameRow(P) && !gameRow(T));
check('the screen may sleep everywhere now', wakeLock.count === 0);

// Continue: the ROM was kept on the laptop.
await until('the laptop can continue the game it played', () => L.root.querySelector('.nes-rom')?.textContent.includes('Test Game'));
coarsePointer = true; // the same game on a touch screen now
buttonByText(L.root.querySelector('.nes-rom'), 'Play').click();
await until('Play boots it from this device', () => frameWin()?.Module?._setGamePadValue && !L.root.querySelector('.nes-stage').hidden, 15000);
await until('with its save in slot 1', () => saveRow(1)?.textContent.includes('just now') && !buttonByText(saveRow(1), 'Load').disabled);
await until('and the phone sees it again', () => gameRow(P)?.textContent.includes('Test Game'));

// The host plays on its own touch screen: the pad over its own picture.
await findRam();
spyPads();
const touchBtn = buttonByText(L.root, 'Touch pad');
check('on a touch screen the host has a Touch pad', Boolean(touchBtn) && !touchBtn.hidden);
check('and Player 1 says so', seat(0).selectedOptions[0].textContent === 'This device (touch pad, keys, gamepad)');
const gameFrame = L.root.querySelector('iframe.nes-frame');
const gameWin = frameWin();
const wrap = L.root.querySelector('.nes-screen-wrap');
touchBtn.click();
await until('Touch pad puts the NES pad over the game’s own picture, filling the screen', () => padOf()?.parentElement === wrap && wrap.classList.contains('pad-on'));
const hpad = padOf();
place(hpad);
check('the game is still the same page: nothing reloaded', L.root.querySelector('iframe.nes-frame') === gameFrame && frameWin() === gameWin && gameFrame.parentElement.parentElement === wrap);
check('its top bar names the game and has Pause', hpad.querySelector('.pad-host').textContent === 'Test Game' && Boolean(buttonByText(hpad, 'Pause')));
const hsurface = hpad.querySelector('.pad-surface');
pointer(hsurface, 'pointerdown', 770, 150, 1);
await until('a finger on A is A on pad 1', () => pads()[0] === A, 3000, () => pads().join());
await sleep(150);
check('and stays down while the finger does', pads()[0] === A);
pointer(hsurface, 'pointerup', 770, 150, 1);
await until('(and up)', () => pads()[0] === 0);
calls.length = 0;
pointer(hsurface, 'pointerdown', 440, 318, 2);
pointer(hsurface, 'pointerup', 440, 318, 2);
await until('a quick tap on Start still reaches the game', () => calls.some(c => c[0] === 0 && c[1] === 3 && c[2] === 0));
check('held for two frames', calls.filter(c => c[1] === 3).map(c => c[2]).join() === '1,0');
key('keydown', 'KeyK');
await until('the keys still play too', () => pads()[0] === A);
key('keyup', 'KeyK');
await until('(up)', () => pads()[0] === 0);
buttonByText(hpad, 'Pause').click();
const still = frames();
await sleep(150);
check('Pause on the pad stops the game', frames() === still && hpad.querySelector('.pad-host').textContent === 'Test Game · paused' && Boolean(buttonByText(hpad, 'Resume')));
await until('and the others see it paused', () => gameRow(P).textContent.includes('paused'));
buttonByText(hpad, 'Resume').click();
await until('Resume goes on', () => frames() !== still && hpad.querySelector('.pad-host').textContent === 'Test Game');
byLabel(hpad, 'Stop').click();
check('Stop on the pad closes the pad, not the game', !padOf() && !wrap.classList.contains('pad-on') && frameWin() === gameWin && !L.root.querySelector('.nes-stage').hidden);
const running = frames();
await sleep(100);
check('(which runs on)', frames() !== running);
buttonByText(L.root, 'Touch pad').click();
await until('(the pad again)', () => padOf()?.parentElement === wrap);
coarsePointer = false;

// A member that runs the tool later hears of the game on link up.
const H = device('Headless', 'd');
await until('a member that arrives sees the game running', () => gameRow(H)?.textContent.includes('Test Game'), 8000);
check('with its players', chip(H, 0)?.textContent === '1 Laptop' && chip(H, 1)?.classList.contains('free'));
// A seat asked for before the pad is there: the pad goes to it when it arrives, not to the first free one.
H.room.send('nes', { type: 'seat', seat: 2 }, L.room.self.peerId);
await sleep(100);
buttonByText(gameRow(H), 'Controller').click();
await until('a member that asked for Player 3 gets Player 3', () => seat(2).selectedOptions[0]?.textContent === 'Headless' && seat(1).value === '');

// Leaving the room (unmounting) stops it.
L.unmount();
await until('a host that leaves takes its game away', () => !gameRow(P) && !gameRow(H));
check('and unloads the emulator, its touch pad with it', !document.querySelector('iframe.nes-frame') && audio.every(ctx => ctx.closed) && !padOf());

P.unmount();
T.unmount();
H.unmount();
for (const dev of [L, P, T, H]) dev.room.leave();
await sleep(50);
check('no errors', errors.length === 0, errors.join(' | '));
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
