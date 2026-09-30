// The Controller tool in jsdom, on the fake peerjs network, with real rooms: a phone as an NES pad for the laptop's
// Monitor (two thumbs at once, a thumb sliding between buttons, the D-pad's diagonals), a tap that is never lost
// when the fast channel drops everything, a tablet in Motion without a fast channel (orientation, Recenter, at most
// 60 messages a second), a gamepad plugged into the phone, the latency and rate, choosing between two hosts, a host
// that stops or leaves, forged input, and the host-side API (getPad, press and release, a slot kept over a reload).
const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, ''); // the repo root
const { JSDOM, VirtualConsole } = await import('jsdom');

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', err => {
	if (!/Not implemented: navigation/.test(err.message)) errors.push(`jsdom: ${err.message}`);
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

const expose = ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history', 'screen',
	'HTMLElement', 'Element', 'Node', 'Text', 'DocumentFragment', 'MutationObserver', 'getComputedStyle',
	'requestAnimationFrame', 'cancelAnimationFrame', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'DOMParser'];
for (const key of expose) Object.defineProperty(globalThis, key, { value: key === 'window' ? window : window[key], configurable: true, writable: true });
let coarsePointer = false; // a phone: its Controller tool opens on the pad, a laptop's on the Monitor
window.matchMedia = globalThis.matchMedia = query => ({ matches: query.includes('coarse') && coarsePointer, addEventListener() {}, removeEventListener() {} });

// What a phone has: full screen, an orientation lock, vibration, gamepads, deviceorientation (no sensor API here).
const calls = { fullscreen: 0, exitFullscreen: 0, lock: [], unlock: 0, vibrate: 0 };
document.documentElement.requestFullscreen = async () => {
	calls.fullscreen++;
	Object.defineProperty(document, 'fullscreenElement', { value: document.documentElement, configurable: true });
};
document.exitFullscreen = async () => {
	calls.exitFullscreen++;
	Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
	document.dispatchEvent(new window.Event('fullscreenchange'));
};
Object.defineProperty(window.screen, 'orientation', {
	value: { angle: 0, lock: async kind => calls.lock.push(kind), unlock: () => calls.unlock++ },
	configurable: true,
});
window.navigator.vibrate = () => {
	calls.vibrate++;
	return true;
};
let gamepads = [];
window.navigator.getGamepads = () => [gamepads[0] ?? null, gamepads[1] ?? null, null, null];
globalThis.DeviceOrientationEvent = window.DeviceOrientationEvent = function DeviceOrientationEvent() {};
const turn = (alpha, beta, gamma) => {
	const e = new window.Event('deviceorientation');
	Object.assign(e, { alpha, beta, gamma });
	window.dispatchEvent(e);
};

const { FakePeer, FakeRTCPeerConnection, fast } = await import('./fakenet.mjs');
globalThis.Peer = window.Peer = FakePeer;
globalThis.RTCPeerConnection = window.RTCPeerConnection = FakeRTCPeerConnection;

const { Room } = await import(`${ROOT}/app/room.js`);
const { Emitter } = await import(`${ROOT}/app/emitter.js`);
const { newRoomCode } = await import(`${ROOT}/app/rooms.js`);
const { CH } = await import(`${ROOT}/app/protocol.js`);
const { wakeLock } = await import(`${ROOT}/app/util.js`);
const { default: controller, cssRotation } = await import(`${ROOT}/app/tools/controller/controller.js`);
const { InputHub, INPUT_TIMING, readState } = await import(`${ROOT}/app/tools/controller/input.js`);
const { fromEuler, multiply } = await import(`${ROOT}/app/tools/controller/motion.js`);

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
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

// --- devices: a room each, with the Controller tool ---

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
	// Each device keeps its own settings, as on its own browser.
	localStorage.clear();
	coarsePointer = phone;
	dev.unmount = controller.mount(dev.root, room, dev.ctx);
	coarsePointer = false;
	return dev;
}

const mode = dev => dev.root.querySelector('.controller-modes [aria-pressed="true"]')?.textContent;
const chips = dev => [...dev.root.querySelectorAll('.host-chip')].map(chip => `${chip.textContent}${chip.getAttribute('aria-pressed') === 'true' ? '*' : ''}`).join(',');
const cards = dev => [...dev.root.querySelectorAll('.mon-card')];
const cardOf = (dev, text) => cards(dev).find(card => card.querySelector('header').textContent.includes(text));
const lit = card => [...(card?.querySelectorAll('.mon-btn.on') ?? [])].map(b => b.textContent).join('+');
const linked = (...devs) => devs.every(dev => dev.room.members.length >= devs.length - 1);

/** The pad a device plays on: the newest `.pad-play` that isn't gone. Buttons get places on screen. */
function padOf() {
	const pads = [...document.querySelectorAll('.pad-play')];
	return pads.at(-1) ?? null;
}
function place(pad) {
	const rects = {
		'.pad-dpad': [0, 0, 200, 200],
		'[aria-label="Select"]': [300, 300, 380, 336],
		'[aria-label="Start"]': [400, 300, 480, 336],
		'[aria-label="B"]': [600, 100, 700, 200],
		'[aria-label="A"]': [720, 100, 820, 200],
		'[aria-label="Trigger"]': [100, 100, 700, 400],
	};
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

const L = device('Laptop', 'a');
const P = device('Phone', 'b', { phone: true });
await until('(the laptop and the phone are linked)', () => linked(L, P), 8000);
fast.off = true; // the tablet's browser has no fast channel: its input goes over ctl
const T = device('Tablet', 'c', { phone: true });
await until('(the three are linked)', () => linked(L, P, T), 8000);
fast.off = false;

check('a laptop opens the Controller tool on the Monitor, a phone on the pad', mode(L) === 'Monitor' && mode(P) === 'Controller' && mode(T) === 'Controller');
await until('the phone offers the laptop, the only member taking input', () => chips(P) === 'Laptop*' && !buttonByText(P.root, 'Start').disabled);
check('the Monitor says how to connect while nobody sends', !L.root.querySelector('.monitor-empty').hidden);

// --- the phone as an NES pad ---

L.shown = false;
buttonByText(P.root, 'Start').click();
await until('Start opens the pad full screen', () => Boolean(padOf()) && calls.fullscreen === 1);
await until('in landscape, with the screen kept on', () => calls.lock.includes('landscape') && wakeLock.count === 1);
const pad = padOf();
place(pad);
const surface = pad.querySelector('.pad-surface');
check('the pad has a D-pad, Select, Start, B and A', ['D-pad', 'Select', 'Start', 'B', 'A'].every(label => byLabel(pad, label)));
await until('the laptop shows the phone as player 1 at once', () => cardOf(L, 'Phone')?.textContent.includes('Player 1 · screen'));
check('and marks the tab while the Monitor is out of sight', L.notified === 1);
L.shown = true;

pointer(surface, 'pointerdown', 770, 150);
await until('A on the phone lights A on the laptop (NES A is the right button, standard 1)', () => lit(cardOf(L, 'Phone')) === 'B');
check('with a short vibration', calls.vibrate === 1);
check('and the button lit on the phone', pad.querySelector('[aria-label="A"]').classList.contains('on'));
pointer(surface, 'pointerup', 770, 150);
await until('and goes out when the thumb lifts', () => lit(cardOf(L, 'Phone')) === '');

// Two thumbs: up on the D-pad and B, then a diagonal, then the right thumb sliding from B to A.
pointer(surface, 'pointerdown', 100, 20, 1);
pointer(surface, 'pointerdown', 650, 150, 2);
await until('two thumbs at once: Up and B both show', () => lit(cardOf(L, 'Phone')) === 'A+Up');
pointer(surface, 'pointermove', 175, 25, 1);
await until('the D-pad has diagonals: up and right', () => lit(cardOf(L, 'Phone')) === 'A+Up+Right');
pointer(surface, 'pointermove', 770, 150, 2);
await until('a thumb sliding from B to A lets go of B', () => lit(cardOf(L, 'Phone')) === 'B+Up+Right');
pointer(surface, 'pointermove', 100, 100, 1);
await until('the middle of the D-pad presses nothing', () => lit(cardOf(L, 'Phone')) === 'B');
pointer(surface, 'pointermove', 716, 150, 2); // 16 px right of B, 4 px left of A
check('a thumb just beside a button still presses it', pad.querySelector('[aria-label="A"]').classList.contains('on'));
pointer(surface, 'pointercancel', 0, 0, 1);
pointer(surface, 'pointerup', 0, 0, 2);
await until('(all up)', () => lit(cardOf(L, 'Phone')) === '');
check('the phone used the fast channel', fast.sent > 0, `${fast.sent} messages`);

// A tap while the fast channel loses everything: its ctl copy still counts it, once.
const hubL = InputHub.of(L.room);
const events = [];
const offPress = hubL.on('press', (slot, i) => events.push(`+${i}`));
const offRelease = hubL.on('release', (slot, i) => events.push(`-${i}`));
fast.drop = owner => owner.id === P.room.self.peerId;
pointer(surface, 'pointerdown', 440, 318, 3);
pointer(surface, 'pointerup', 440, 318, 3);
await until('a tap sent while every fast message is lost still reaches the laptop: a press and a release', () => events.join(' ') === '+9 -9', 2000, () => events.join(' '));
fast.drop = () => false;
events.length = 0;
pointer(surface, 'pointerdown', 440, 318, 3);
await sleep(40);
pointer(surface, 'pointerup', 440, 318, 3);
await until('with both copies arriving, a press counts once', () => events.join(' ') === '+9 -9', 2000, () => events.join(' '));
await sleep(100);
check('(and only once)', events.join(' ') === '+9 -9', events.join(' '));
offPress();
offRelease();

// A gamepad plugged into the phone goes along as a pad of its own.
const gp = { index: 0, id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e)', buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0] };
gamepads = [gp];
window.dispatchEvent(new window.Event('gamepadconnected'));
await until('a gamepad plugged into the phone shows on the laptop as player 2', () => cardOf(L, 'gamepad 1')?.textContent.includes('Player 2 · gamepad 1'));
gp.buttons[3] = { pressed: true, value: 1 };
gp.axes = [0.5, -1, 0, 0];
await until('its buttons', () => lit(cardOf(L, 'gamepad 1')) === 'Y');
await until('and its sticks', () => cardOf(L, 'gamepad 1').querySelector('.mon-dot').style.transform === 'translate(25.0%, -50.0%)');
check('the phone’s own pad is still player 1', lit(cardOf(L, 'Player 1')) === '');
gamepads = [];
await until('unplugged, it goes from the laptop', () => !cardOf(L, 'gamepad 1'));

await until('the laptop shows the latency and the messages per second', () => /^\d+ ms · \d+\/s$/.test(cardOf(L, 'Phone').querySelector('.mon-stats').textContent), 3000, () => cardOf(L, 'Phone')?.querySelector('.mon-stats').textContent);
check('and the phone its latency', /^\d+ ms$/.test(pad.querySelector('.pad-latency').textContent), pad.querySelector('.pad-latency').textContent);

// The Gamepad-shaped snapshot for games.
const snap = hubL.getPad(0);
check('getPad(slot) is shaped like a Gamepad', snap.mapping === 'standard' && snap.buttons.length === 17 && snap.axes.length === 4 && snap.connected && snap.name === 'Phone' && snap.id === 'Phone (screen)');
check('getPad of a slot nobody has is null', hubL.getPad(7) === null);

// Stop: the laptop drops the pad.
byLabel(pad, 'Stop').click();
await until('Stop closes the pad and the laptop drops it', () => !padOf() && !cardOf(L, 'Phone'));
check('full screen, the orientation lock and the wake lock are let go', calls.exitFullscreen === 1 && calls.unlock === 1 && wakeLock.count === 0);
check('the Monitor says how to connect again', !L.root.querySelector('.monitor-empty').hidden);

// --- the tablet in Motion, without a fast channel ---

buttonByText(T.root, 'Motion').click();
buttonByText(T.root, 'Start').click();
await until('Motion has a big trigger and Recenter', () => padOf() && byLabel(padOf(), 'Trigger') && buttonByText(padOf(), 'Recenter'));
const tpad = padOf();
place(tpad);
let fromT = 0;
L.room.on(`msg:${CH.INPUT}`, (msg, member) => member?.peerId === T.room.self.peerId && msg.type === 'state' && fromT++);
const fastBefore = fast.sent;
turn(0, 90, 0); // standing up, the screen towards the user
await until('the tablet’s orientation reaches the laptop’s Monitor', () => {
	const q = hubL.getPad(hubL.list().find(p => p.name === 'Tablet')?.index)?.orientation;
	return q && near(q[0], Math.SQRT1_2) && near(q[3], Math.SQRT1_2);
});
const tcard = cardOf(L, 'Tablet');
await until('and turns the phone drawn there', () => !tcard.querySelector('.mon-motion').hidden && tcard.querySelector('.mon-cube').style.transform.startsWith('matrix3d(1.0000,0.0000,0.0000,0,0.0000,0.0000,'), 1000, () => tcard.querySelector('.mon-cube').style.transform);
check('over ctl: the tablet has no fast channel', fast.sent === fastBefore);
buttonByText(tpad, 'Recenter').click();
const tslot = () => hubL.list().find(p => p.name === 'Tablet').index;
await until('Recenter makes the way it points now straight ahead', () => {
	const q = hubL.getPad(tslot()).orientation;
	return near(q[0], 0) && near(q[3], 1);
});
turn(0, 90, 30);
await until('and turns are measured from there', () => {
	const q = hubL.getPad(tslot()).orientation;
	return near(q[3], Math.cos(15 * Math.PI / 180)) && near(Math.hypot(q[0], q[1], q[2]), Math.sin(15 * Math.PI / 180));
});

// At most 60 messages a second, however often the phone reports.
await sleep(50);
fromT = 0;
const burstStart = Date.now();
for (let i = 0; i < 200; i++) {
	turn(0, 90, 30 + (i % 40));
	if (i % 20 === 19) await sleep(25);
}
const burstMs = Date.now() - burstStart;
await sleep(60);
check('200 readings in a burst make at most 60 messages a second', fromT >= 2 && fromT <= Math.ceil((burstMs + 60) / INPUT_TIMING.gap) + 1, `${fromT} messages in ${burstMs + 60} ms`);

pointer(tpad.querySelector('.pad-surface'), 'pointerdown', 400, 250);
await until('the trigger is the right trigger (standard 7)', () => lit(cardOf(L, 'Tablet')) === 'RT');
pointer(tpad.querySelector('.pad-surface'), 'pointerup', 400, 250);
await until('(released)', () => lit(cardOf(L, 'Tablet')) === '');

// The laptop stops taking input: the tablet stops too.
buttonByText(L.root.querySelector('.controller-modes'), 'Controller').click();
await until('a host that stops taking input stops the controllers on it', () => !padOf() && wakeLock.count === 0);
check('and says so', [...document.querySelectorAll('.toast')].some(t => t.textContent === 'Laptop stopped taking input'));
await until('nobody else takes input: Start waits', () => buttonByText(T.root, 'Start').disabled && !T.root.querySelector('.controller-setup .hint').hidden);

// --- two hosts ---

buttonByText(L.root.querySelector('.controller-modes'), 'Monitor').click();
buttonByText(T.root.querySelector('.controller-modes'), 'Monitor').click();
await until('with two hosts the phone offers both', () => chips(P).split(',').sort().join(',') === 'Laptop*,Tablet', 3000, () => chips(P));
[...P.root.querySelectorAll('.host-chip')].find(chip => chip.textContent === 'Tablet').click();
check('and one can be chosen', chips(P).includes('Tablet*'));
buttonByText(P.root, 'Start').click();
await until('the pad goes to the chosen one', () => Boolean(cardOf(T, 'Phone')) && !cardOf(L, 'Phone'));
check('whose name is on the pad', padOf().querySelector('.pad-host').textContent === 'Tablet');

// --- forged input ---

const H = new Room({ code, ice: ice(), identity: { id: 'e'.repeat(16), name: 'Headless' } });
H.start();
await until('(a headless member joins)', () => H.members.length === 3, 8000);
const lp = L.room.self.peerId;
const before = cards(L).length;
for (const msg of [
	{ type: 'state', slot: 9, seq: 1, buttons: 1, axes: [] },
	{ type: 'state', slot: 0, seq: 1, buttons: 1 << 20, axes: [] },
	{ type: 'state', slot: 0, seq: -1, buttons: 1, axes: [] },
	{ type: 'state', slot: 0, seq: 1, buttons: 1, axes: [NaN] },
	{ type: 'state', slot: 0, seq: 1, buttons: 1, axes: [0, 0, 0, 0, 0] },
	{ type: 'state', slot: 0, seq: 1, buttons: 1, axes: [], quat: [0, 0, 0, 0] },
	{ type: 'state', slot: 0, seq: 1, buttons: 1, axes: [], down: 'x' },
	{ type: 'state', slot: '0', seq: 1, buttons: 1, axes: [] },
]) {
	H.send(CH.INPUT, msg, lp);
	H.sendFast(CH.INPUT, msg, lp);
}
H.send(CH.INPUT, { type: 'leave', slot: 0 }, T.room.self.peerId); // the phone's pad, from someone else
H.send(CH.INPUT, { type: 'echo', t: -5 }, P.room.self.peerId); // an echo from a member that isn't the host
H.sendFast(CH.SYS, { type: 'bye' }, lp); // links stay on ctl
await sleep(300);
check('input that fails the checks makes no pad', cards(L).length === before);
check('a member can’t take another member’s pad away', Boolean(cardOf(T, 'Phone')));
check('nor end a link over the fast channel', L.room.member(H.self.peerId) !== null);
check('the checks keep good values and clamp the rest', readState({ slot: 1, seq: 3, buttons: 5, axes: [2, -0.5] })?.axes.join() === '1,-0.5,0,0'
	&& readState({ slot: 1, seq: 3, buttons: 5, axes: [], quat: [0, 0, 0, 1.2] })?.quat.join() === '0,0,0,1'
	&& readState({ slot: 1, seq: 3, buttons: 5, axes: [], quat: [0, 0, 0, 2] }) === null);
H.send(CH.INPUT, { type: 'state', slot: 0, seq: 1, buttons: 1, axes: [] }, lp);
await until('a member sending good input is a player like any other', () => cardOf(L, 'Headless')?.textContent.includes('Player'));

// --- the host's side, message by message ---

const fake = Object.assign(new Emitter(), { sent: [], send() {}, sendFast(ch, msg, to) { this.sent.push(msg); }, members: [], member: () => null });
const hub = new InputHub(fake);
const release = hub.take();
const got = [];
hub.on('press', (slot, i) => got.push(`+${i}`));
hub.on('release', (slot, i) => got.push(`-${i}`));
const phone = { peerId: 'p1', deviceId: 'd'.repeat(16), name: 'Phone', color: '#123456' };
const msg = (seq, buttons, down = 0) => ({ type: 'state', slot: 0, seq, t: 1, buttons, down, axes: [] });
fake.emit(`msg:${CH.INPUT}`, msg(1, 0), phone);
fake.emit(`msg:${CH.INPUT}`, msg(3, 0), phone); // the release, first
fake.emit(`msg:${CH.INPUT}`, msg(2, 1, 1), phone); // then the press it followed, late (its ctl copy)
check('a press that arrives after its release is a tap: press and release at once', got.join(' ') === '+0 -0', got.join(' '));
got.length = 0;
fake.emit(`msg:${CH.INPUT}`, msg(4, 2, 2), phone);
fake.emit(`msg:${CH.INPUT}`, msg(4, 2, 2), phone); // the same message on the other channel
check('the same press over both channels counts once', got.join(' ') === '+1', got.join(' '));
fake.emit(`msg:${CH.INPUT}`, msg(6, 0), phone);
fake.emit(`msg:${CH.INPUT}`, msg(5, 2, 0), phone); // a stale copy without a press in it
check('a stale message changes nothing', got.join(' ') === '+1 -1' && hub.getPad(0).buttons[1].pressed === false, got.join(' '));
check('the host echoes the controller’s clock, at most once a second', fake.sent.filter(m => m.type === 'echo').length === 1);
const reloaded = { ...phone, peerId: 'p2' };
const other = { peerId: 'q1', deviceId: 'f'.repeat(16), name: 'Other', color: '#654321' };
fake.emit(`msg:${CH.INPUT}`, msg(1, 0), other);
fake.emit(`msg:${CH.INPUT}`, msg(1, 4), reloaded);
check('a device that reloads comes back to its slot', hub.getPad(0)?.peerId === 'p2' && hub.getPad(1)?.name === 'Other' && hub.getPad(0).buttons[2].pressed);
fake.emit('link-down', other);
check('a member whose link drops loses its pad', hub.getPad(1) === null && hub.list().length === 1);
release();
check('letting go of the hub drops every pad', hub.list().length === 0);

// --- the maths ---

const q = fromEuler(0, 90, 0);
check('deviceorientation angles become a quaternion', near(q[0], Math.SQRT1_2) && near(q[3], Math.SQRT1_2));
const back = multiply([-q[0], -q[1], -q[2], q[3]], q);
check('a quaternion times its conjugate is none', near(back[3], 1) && near(back[0], 0));
check('no rotation draws the phone as it is', cssRotation([0, 0, 0, 1]) === 'matrix3d(1.0000,0.0000,0.0000,0,0.0000,1.0000,0.0000,0,0.0000,0.0000,1.0000,0,0,0,0,1)');

// --- a host that leaves ---

await H.leave();
await T.room.leave();
await until('a host that leaves stops the controller on it', () => !padOf() && wakeLock.count === 0);
check('and says so', [...document.querySelectorAll('.toast')].some(t => t.textContent === 'Tablet left: the controller stopped'));
await until('and the phone offers the laptop again', () => chips(P) === 'Laptop*');

for (const dev of [L, P, T]) dev.unmount();
await L.room.leave();
await P.room.leave();
await sleep(50);
check('no errors logged', errors.length === 0, errors.slice(0, 3).join(' | '));
const unexpected = warnings.filter(w => !/peer error|no fast channel/.test(w));
check('no unexpected warnings', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
