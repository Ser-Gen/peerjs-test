// The Games tool with the Swing test in jsdom, on the fake peerjs network: a laptop lists the games it can run and
// starts the Swing test, a phone joins and gets the Motion pad the game asks for (its orientation from
// deviceorientation events), and a headless member sends its pad's messages itself. Checked: swings measured from
// the quaternions (speed, strength, direction, a jolt that isn't a swing), hard and soft swings to the left and
// right on the phone's card, a second player, the trigger clearing a player's numbers, Pause, a player who goes
// away, Stop sending the phone back from its pad, and the small pieces (the game message, seats without this device).
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
console.warn = () => {};

const expose = ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history', 'screen',
	'HTMLElement', 'Element', 'Node', 'Text', 'DocumentFragment', 'MutationObserver', 'getComputedStyle',
	'requestAnimationFrame', 'cancelAnimationFrame', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'DOMParser'];
for (const key of expose) Object.defineProperty(globalThis, key, { value: key === 'window' ? window : window[key], configurable: true, writable: true });
let coarsePointer = false;
window.matchMedia = globalThis.matchMedia = query => ({ matches: query.includes('coarse') && coarsePointer, addEventListener() {}, removeEventListener() {} });
document.documentElement.requestFullscreen = async () => {};
Object.defineProperty(window.screen, 'orientation', { value: { angle: 0, lock: async () => {}, unlock: () => {} }, configurable: true });
window.navigator.vibrate = () => true;
window.navigator.getGamepads = () => [null, null, null, null];
globalThis.DeviceOrientationEvent = window.DeviceOrientationEvent = function DeviceOrientationEvent() {};
const turn = (alpha, beta, gamma) => {
	const e = new window.Event('deviceorientation');
	Object.assign(e, { alpha, beta, gamma });
	window.dispatchEvent(e);
};

const { FakePeer, FakeRTCPeerConnection } = await import('./fakenet.mjs');
globalThis.Peer = window.Peer = FakePeer;
globalThis.RTCPeerConnection = window.RTCPeerConnection = FakeRTCPeerConnection;

const { Room } = await import(`${ROOT}/app/room.js`);
const { Emitter } = await import(`${ROOT}/app/emitter.js`);
const { newRoomCode } = await import(`${ROOT}/app/rooms.js`);
const { CH } = await import(`${ROOT}/app/protocol.js`);
const { wakeLock } = await import(`${ROOT}/app/util.js`);
const { default: games, GAMES, readGame } = await import(`${ROOT}/app/tools/games/games.js`);
const { Seats } = await import(`${ROOT}/app/tools/games/seats.js`);
const { InputHub } = await import(`${ROOT}/app/tools/controller/input.js`);
const { SWING, SwingMeter, angularVelocity, direction, strength } = await import(`${ROOT}/app/games/swing/swing.js`);

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

const DEG = Math.PI / 180;
/** A turn of `deg` degrees about an axis (x, y or z), as a quaternion [x, y, z, w]. */
const about = (axis, deg) => {
	const q = [0, 0, 0, Math.cos((deg * DEG) / 2)];
	q['xyz'.indexOf(axis)] = Math.sin((deg * DEG) / 2);
	return q;
};
const near = (a, b, d = 1) => Math.abs(a - b) <= d;
{
	const w = angularVelocity(about('y', 0), about('y', 90), 500);
	check('a quarter turn about the up axis in half a second is 180°/s about it', near(w[1], 180) && near(w[0], 0) && near(w[2], 0), w.map(Math.round).join());
	const back = angularVelocity(about('y', 10), about('y', -10), 100);
	check('turning back is the other sign', near(back[1], -200));
	const wrap = angularVelocity(about('z', 179), about('z', -179), 10);
	check('and a turn across ±180° is the short way round', near(Math.hypot(...wrap), 200, 2), `${Math.round(Math.hypot(...wrap))}`);
}
check('strength: soft, medium, hard', strength(300) === 'Soft' && strength(SWING.soft) === 'Medium' && strength(SWING.hard) === 'Hard');
check('direction: the way it turned the most', direction([0, 50, 10]) === 'left' && direction([5, -50, 10]) === 'right' && direction([40, 5, 1]) === 'up'
	&& direction([-40, 5, 1]) === 'down' && direction([1, 2, 30]) === 'twist');

/** Readings of a swing at 60 a second: `speed` °/s about `axis` for `ms`, then still; returns what the meter said. */
function swingOf(meter, axis, speed, ms, { t0 = 0, from = 0 } = {}) {
	const results = [];
	let t = t0;
	let angle = from;
	const read = () => {
		const r = meter.update(about(axis, angle), t);
		if (r) results.push(r);
	};
	read();
	for (; t < t0 + ms;) {
		t += 1000 / 60;
		angle += (speed * 1000) / 60 / 1000;
		read();
	}
	for (let i = 0; i < 5; i++) {
		t += 1000 / 60;
		read();
	}
	return { results, t, angle };
}
{
	const meter = new SwingMeter();
	const hard = swingOf(meter, 'y', -1200, 150);
	check('a hard swing to the right is one swing: Hard, right, about 1200°/s', hard.results.length === 1 && hard.results[0].strength === 'Hard'
		&& hard.results[0].direction === 'right' && near(hard.results[0].speed, 1200, 30), JSON.stringify(hard.results));
	const soft = swingOf(meter, 'y', 300, 300, { t0: hard.t, from: hard.angle });
	check('a soft one to the left: Soft, left, about 300°/s', soft.results.length === 1 && soft.results[0].strength === 'Soft' && soft.results[0].direction === 'left'
		&& near(soft.results[0].speed, 300, 15), JSON.stringify(soft.results));
	check('the meter keeps the last, the best and the count', meter.last.direction === 'left' && meter.best.strength === 'Hard' && meter.count === 2);
	const up = swingOf(meter, 'x', 600, 200, { t0: soft.t });
	check('a swing upwards is up', up.results[0]?.direction === 'up' && up.results[0].strength === 'Medium');
	const jolt = new SwingMeter();
	jolt.update(about('y', 0), 0);
	jolt.update(about('y', 10), 16);
	check('a jolt (fast, but only 10°) isn’t a swing', jolt.update(about('y', 10), 33) === null && jolt.count === 0);
	check('a slow turn isn’t either', swingOf(new SwingMeter(), 'y', 120, 1000).results.length === 0);
	const gap = new SwingMeter();
	gap.update(about('y', 0), 0);
	gap.update(about('y', 20), 16);
	gap.update(about('y', 40), 33);
	const ended = gap.update(about('y', 40), 600);
	check('a swing whose next reading comes late ends there', ended?.direction === 'left' && gap.speed === 0);
	const still = new SwingMeter();
	still.update(about('y', 0), 0);
	still.update(about('y', 20), 16);
	still.update(about('y', 40), 33);
	const stopped = still.idle();
	check('a phone that stops sending ends its swing when the readings stop (the host’s timer)', stopped?.direction === 'left' && still.speed === 0 && still.idle() === null);
	meter.reset();
	check('reset clears the numbers', meter.count === 0 && meter.best === null && meter.last === null);
}

check('a game message names its module and the pad it wants', readGame({ game: 'swing', title: 'Swing test', layout: 'motion' }).layout === 'motion'
	&& readGame({ game: 'swing', title: 'Swing test', layout: 'motion' }).game === 'swing');
check('and is checked: an unknown layout is the NES pad, a bad id none', readGame({ game: '<b>', title: 'X', layout: 'toString' }).layout === 'nes'
	&& readGame({ game: '<b>', title: 'X' }).game === null && readGame({ title: 'X', players: [null, null] }).players.length === 2);
{
	const seats = new Seats(4, { host: false });
	check('a game this device doesn’t play has no seat for it: the first pad is Player 1', seats.seats[0] === null && seats.arrive('pad:3') === 0);
	const two = new Seats(2);
	check('and a game for two has two seats', two.seats.length === 2 && two.arrive('pad:0') === 1 && two.arrive('pad:1') === -1);
	two.assign(5, 'pad:1');
	check('(a seat that isn’t there takes nobody)', two.seats.join() === 'host,pad:0');
}
check('the games: NES and Swing test, with the pads they want', GAMES.map(g => `${g.id}:${g.layout}`).join() === 'nes:nes,swing:motion');

// --- devices ---

const code = newRoomCode();
const ice = () => ({ forRoom: null, adopt: () => false });
function device(name, letter, { phone = false, tool = true } = {}) {
	const identity = Object.assign(new Emitter(), { id: letter.repeat(16), name });
	const room = new Room({ code, ice: ice(), identity });
	room.start();
	const dev = { name, letter, room, notified: 0, shown: true };
	if (!tool) return dev;
	dev.root = document.createElement('section');
	document.querySelector('.app').append(dev.root);
	dev.ctx = { room: letter.repeat(32), activate() {}, notify: () => dev.notified++, visible: () => dev.shown };
	coarsePointer = phone;
	dev.unmount = games.mount(dev.root, room, dev.ctx);
	coarsePointer = false;
	return dev;
}
const L = device('Laptop', 'a');
const P = device('Phone', 'b', { phone: true });
const H = device('Headless', 'd', { tool: false });
await until('(the three are linked)', () => [L, P, H].every(dev => dev.room.members.length >= 2), 8000);

const gameSection = (dev, id) => dev.root.querySelector(`.games-module[data-game="${id}"]`);
check('Play here lists the games this device can run, with how many play', gameSection(L, 'nes')?.querySelector('h3').textContent === 'NES · 1–4 players'
	&& gameSection(L, 'swing')?.querySelector('h3').textContent === 'Swing test · 1–4 players');
check('the NES opens a ROM there, the Swing test just starts', Boolean(buttonByText(gameSection(L, 'nes'), 'Open a ROM…')) && Boolean(buttonByText(gameSection(L, 'swing'), 'Start')));

P.shown = false;
buttonByText(gameSection(L, 'swing'), 'Start').click();
await until('Start runs the Swing test here: a card per player, all free', () => !L.root.querySelector('.games-stage').hidden && L.root.querySelectorAll('.swing-card.empty').length === 4);
check('with the screen kept on', wakeLock.count === 1);
check('and no seat for this device: the laptop has no motion to play with', [...L.root.querySelectorAll('.games-seat select')][0].value === ''
	&& ![...L.root.querySelectorAll('.games-seat option')].some(o => o.value === 'host'));
check('nothing to stream, no Touch pad', !buttonByText(L.root, 'Touch pad'));
const gameRow = dev => dev.root.querySelector('.games-game');
await until('the phone sees it, and only Join (no picture to stream)', () => gameRow(P)?.textContent.includes('Swing test') && Boolean(buttonByText(gameRow(P), 'Join')) && !buttonByText(gameRow(P), 'Remote play'));
check('the tab is marked while out of sight', P.notified === 1);
P.shown = true;

const padOf = () => [...document.querySelectorAll('.pad-play')].at(-1) ?? null;
const seatBtn = pad => [...pad.querySelectorAll('.pad-top-btn')].find(b => /^(Player \d|Not playing)$/.test(b.textContent));
buttonByText(gameRow(P), 'Join').click();
await until('Join opens the Motion pad, the one the game asks for', () => padOf()?.querySelector('.pad-surface').dataset.layout === 'motion' && Boolean(byLabel(padOf(), 'Trigger')) && Boolean(buttonByText(padOf(), 'Recenter')));
const ppad = padOf();
const card = i => L.root.querySelector(`.swing-card[data-seat="${i}"]`);
await until('the phone is Player 1', () => seatBtn(ppad)?.textContent === 'Player 1' && card(0).querySelector('.swing-name').textContent === 'Phone' && !card(0).classList.contains('empty'));
check('its card in its colour', card(0).style.getPropertyValue('--member') === P.room.self.color);
check('and the Monitor numbers it as the game does', InputHub.of(L.room).seats.get(0) === 0);

// The phone stands up facing its user; Recenter makes that straight ahead.
turn(0, 90, 0);
await sleep(50);
buttonByText(ppad, 'Recenter').click();
await until('(a still phone reads no speed)', () => card(0).querySelector('.swing-speed').textContent === '0°/s' && card(0).querySelector('.swing-last').textContent === 'Swing!');

/** The phone turned about the vertical (alpha) by `step` degrees a reading, `n` readings ~60 a second apart. */
async function swingPhone(step, n) {
	let alpha = 0;
	for (let i = 0; i < n; i++) {
		alpha += step;
		turn(((alpha % 360) + 360) % 360, 90, 0);
		await sleep(17);
	}
	return alpha;
}
let alpha = await swingPhone(24, 6); // ~1400°/s, counter-clockwise seen from above: to the left
const last = () => card(0).querySelector('.swing-last').textContent;
await until('a hard swing to the left reads Hard and left, as soon as the phone stops (not at its next message, 0.5 s on)', () => /^Hard · \d+°\/s · ← left$/.test(last()), 450, last);
check('the peak shows on the meter', !card(0).querySelector('.swing-peak').hidden);
const hardSpeed = Number(last().match(/(\d+)°/)[1]);
// Back the other way, gently: ~240°/s.
for (let i = 0; i < 25; i++) {
	alpha -= 4;
	turn(((alpha % 360) + 360) % 360, 90, 0);
	await sleep(17);
}
await until('a soft swing to the right reads Soft and right', () => /^Soft · \d+°\/s · right →$/.test(last()), 3000, last);
const softSpeed = Number(last().match(/(\d+)°/)[1]);
check('clearly apart: the hard one several times the soft one', hardSpeed > 3 * softSpeed && hardSpeed >= SWING.hard, `${hardSpeed} vs ${softSpeed}`);
check('the best is the hard one, two swings', card(0).querySelector('.swing-best').textContent === `Best ${hardSpeed}°/s · 2 swings`);

// A second player: the headless member sends its pad's messages itself, with its own clock.
let seq = 0;
let clock = 1000;
const send = quat => {
	clock += 1000 / 60;
	H.room.send(CH.INPUT, { type: 'state', slot: 0, seq: ++seq, t: clock, buttons: 0, down: 0, axes: [], quat }, L.room.self.peerId);
};
send(about('x', 0));
await until('a second pad is Player 2', () => card(1).querySelector('.swing-name').textContent === 'Headless');
for (let a = 10; a <= 100; a += 10) send(about('x', a)); // 600°/s upwards
send(about('x', 100));
await until('its upward swing is on its own card: Medium, up', () => /^Medium · \d+°\/s · ↑ up$/.test(card(1).querySelector('.swing-last').textContent), 3000, () => card(1).querySelector('.swing-last').textContent);
check('and the phone’s card didn’t change', card(0).querySelector('.swing-best').textContent === `Best ${hardSpeed}°/s · 2 swings`);
H.room.send(CH.INPUT, { type: 'state', slot: 0, seq: ++seq, t: clock, buttons: 0, down: 0, axes: [], quat: [0, 0, 0, 0] }, L.room.self.peerId);
H.room.send(CH.INPUT, { type: 'state', slot: 0, seq: ++seq, t: clock, buttons: 0, down: 0, axes: [], quat: [1e9, 0, 0, 1] }, L.room.self.peerId);
await sleep(100);
check('forged orientations change nothing', /^Medium/.test(card(1).querySelector('.swing-last').textContent));

// The trigger clears the phone's numbers.
const trigger = byLabel(ppad, 'Trigger');
trigger.getBoundingClientRect = () => ({ left: 100, top: 100, right: 500, bottom: 300, width: 400, height: 200 });
const pointer = (type, x, y) => {
	const e = new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
	Object.defineProperties(e, { pointerId: { value: 1 }, pointerType: { value: 'touch' } });
	ppad.querySelector('.pad-surface').dispatchEvent(e);
};
pointer('pointerdown', 300, 200);
pointer('pointerup', 300, 200);
await until('the trigger clears that player’s numbers', () => last() === 'Swing!' && card(0).querySelector('.swing-best').textContent === '' && card(0).querySelector('.swing-peak').hidden);
check('only theirs', /^Medium/.test(card(1).querySelector('.swing-last').textContent));

// Pause: swings don't count.
buttonByText(L.root, 'Pause').click();
await until('Pause tells the phone', () => ppad.querySelector('.pad-host').textContent === 'Laptop · Swing test · paused');
alpha = await swingPhone(24, 6);
await sleep(700);
check('a swing while paused isn’t counted', last() === 'Swing!', last());
L.root.querySelector('.games-notice').click();
await until('a tap on the board goes on', () => ppad.querySelector('.pad-host').textContent === 'Laptop · Swing test');

// The phone stops its pad: the game waits for it.
byLabel(ppad, 'Stop').click();
await until('a player that stops pauses the game, and says who it waits for', () => L.root.querySelector('.games-notice').textContent.includes('waiting for Phone') && card(0).classList.contains('away'));
buttonByText(gameRow(P), 'Join').click();
await until('back on the Motion pad, the phone has its card again and the game goes on', () => padOf() !== ppad && padOf()?.querySelector('.pad-surface').dataset.layout === 'motion'
	&& !card(0).classList.contains('away') && L.root.querySelector('.games-notice').hidden);

// Stop: the phone leaves its pad, the laptop is back in the lobby.
buttonByText(L.root, 'Stop').click();
await until('Stop sends the phone back from its pad, saying why', () => !padOf() && toasts().includes('Laptop stopped the game') && !gameRow(P));
check('the laptop is back in the lobby, its screen free to sleep', L.root.querySelector('.games-stage').hidden && !L.root.querySelector('.games-lobby').hidden && wakeLock.count === 0);
check('and the Monitor numbers pads in order again', InputHub.of(L.room).seats === null);

L.unmount();
P.unmount();
for (const dev of [L, P, H]) dev.room.leave();
await sleep(50);
check('no errors', errors.length === 0, errors.join(' | '));
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
