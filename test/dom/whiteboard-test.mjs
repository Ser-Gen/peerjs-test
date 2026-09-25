// The Whiteboard tool in jsdom, on the fake peerjs network, with real rooms: three devices drawing together, a
// headless member that watches the strokes in progress and writes forged items, undo of one's own strokes only,
// the eraser, a pinch, a stylus, drawing offline, images from the clipboard, a file and a drop, moving and
// resizing, the board list, and the PNG export into the Chat. jsdom has no canvas: a recording 2D context,
// createImageBitmap and canvas.toBlob stand in, with images whose size is written in their first bytes.
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

const expose = ['window', 'Window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history',
	'HTMLElement', 'HTMLDialogElement', 'HTMLAnchorElement', 'HTMLInputElement', 'Element', 'Node', 'Text', 'DocumentFragment',
	'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'Range', 'Selection',
	'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'InputEvent', 'FocusEvent', 'CompositionEvent', 'DOMParser', 'File', 'Blob'];
for (const key of expose) Object.defineProperty(globalThis, key, { value: key === 'window' ? window : window[key], configurable: true, writable: true });
window.matchMedia = globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.confirm = globalThis.confirm = () => true;
window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
window.HTMLDialogElement.prototype.close = function () {
	if (!this.hasAttribute('open')) return;
	this.removeAttribute('open');
	this.dispatchEvent(new window.Event('close'));
};
window.HTMLElement.prototype.scrollIntoView ??= () => {};
window.URL.createObjectURL = globalThis.URL.createObjectURL = () => 'blob:https://peerkit.test/1';
window.URL.revokeObjectURL = globalThis.URL.revokeObjectURL = () => {};
const downloads = [];
window.HTMLAnchorElement.prototype.click = function () {
	if (this.hasAttribute('download')) downloads.push(this.getAttribute('download'));
};

// --- a canvas that records what is drawn, and images that say their size in their first bytes ---

const contexts = [];
class FakeContext {
	constructor(canvas) {
		this.canvas = canvas;
		this.ops = [];
		Object.assign(this, { fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, globalAlpha: 1, globalCompositeOperation: 'source-over', font: '' });
	}
	stroke() {
		this.ops.push(['stroke', this.strokeStyle, this.lineWidth, this.globalAlpha, this.globalCompositeOperation]);
	}
	drawImage(image, x, y, w, h) {
		this.ops.push(['drawImage', image, x, y, w, h]);
	}
	setTransform(...args) {
		this.ops.push(['setTransform', ...args]);
	}
	measureText(text) {
		return { width: text.length * 7 };
	}
}
for (const name of ['save', 'restore', 'translate', 'beginPath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'arc', 'fill', 'fillRect',
	'clearRect', 'strokeRect', 'setLineDash', 'fillText']) {
	FakeContext.prototype[name] = function (...args) {
		this.ops.push([name, ...args]);
	};
}
const contextOf = new WeakMap();
window.HTMLCanvasElement.prototype.getContext = function (kind) {
	if (kind !== '2d') return null;
	if (!contextOf.has(this)) {
		const ctx = new FakeContext(this);
		contextOf.set(this, ctx);
		contexts.push(ctx);
	}
	return contextOf.get(this);
};
const HEADER = /^FAKEIMG (\d+)x(\d+)\n/;
function fakeImage(width, height, { size = 64, type = 'image/png' } = {}) {
	const head = new TextEncoder().encode(`FAKEIMG ${width}x${height}\n`);
	const bytes = new Uint8Array(Math.max(size, head.length));
	bytes.set(head);
	return new Blob([bytes], { type });
}
const sizeOf = bytes => HEADER.exec(new TextDecoder().decode(bytes.slice(0, 40)))?.slice(1).map(Number) ?? null;
// Encoded sizes that grow with the picture: PNG 0.5 bytes a pixel, WebP 0.3, JPEG 0.35.
window.HTMLCanvasElement.prototype.toBlob = function (callback, type = 'image/png') {
	const perPixel = { 'image/png': 0.5, 'image/webp': 0.3, 'image/jpeg': 0.35 }[type] ?? 0.5;
	const { width, height } = this;
	setTimeout(() => callback(fakeImage(width, height, { size: Math.round(width * height * perPixel), type })), 1);
};
const bitmaps = [];
globalThis.createImageBitmap = window.createImageBitmap = async blob => {
	const size = sizeOf(new Uint8Array(await blob.arrayBuffer()));
	if (!size) throw new window.DOMException('The source image could not be decoded.', 'InvalidStateError');
	const bitmap = { width: size[0], height: size[1], closed: false, close() { this.closed = true; } };
	bitmaps.push(bitmap);
	return bitmap;
};
// The async Clipboard API: what the test puts on the clipboard.
let clipboard = [];
Object.defineProperty(window.navigator, 'clipboard', {
	value: { read: async () => clipboard.map(blob => ({ types: [blob.type], getType: async () => blob })) },
	configurable: true,
});

await import('fake-indexeddb/auto');
for (const key of Object.getOwnPropertyNames(window).filter(k => /^(indexedDB|IDB)/.test(k))) {
	Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
const { FakePeer } = await import('./fakenet.mjs');
globalThis.Peer = window.Peer = FakePeer;

const { Room } = await import(`${ROOT}/app/room.js`);
const { newRoomCode } = await import(`${ROOT}/app/rooms.js`);
const { CH } = await import(`${ROOT}/app/protocol.js`);
const { RoomDoc, boardDocName } = await import(`${ROOT}/app/roomdoc.js`);
const { default: whiteboard } = await import(`${ROOT}/app/tools/whiteboard/whiteboard.js`);
const { default: chat } = await import(`${ROOT}/app/tools/chat/chat.js`);
const { Boards } = await import(`${ROOT}/app/tools/whiteboard/boards.js`);
const { itemBounds, packPoints, simplify, hits, unionBounds } = await import(`${ROOT}/app/tools/whiteboard/ink.js`);

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
const buttonByText = (root, text) => [...root.querySelectorAll('button')].find(b => b.textContent.trim() === text);
const byLabel = (root, label) => root.querySelector(`[aria-label="${label}"]`);
const lastDialog = () => [...document.querySelectorAll('dialog[open]')].at(-1);
const toasts = () => document.getElementById('toasts').textContent;

// --- ink.js on its own ---

const line = [];
for (let i = 0; i <= 50; i++) line.push(i * 2, 0, 0.5);
check('simplify keeps the ends of a straight line and drops the rest', simplify(line, 0.5).length === 6);
const corner = [0, 0, 0.5, 50, 0, 0.5, 100, 0, 0.5, 100, 50, 0.5, 100, 100, 0.5];
check('and keeps a corner', simplify(corner, 0.5).join() === [0, 0, 0.5, 100, 0, 0.5, 100, 100, 0.5].join());
const pressed = [0, 0, 0.2, 50, 0, 0.9, 100, 0, 0.2];
check('and on a straight line, where the pressure changes', simplify(pressed, 0.5).length === 9 && simplify([0, 0, 0.2, 50, 0, 0.5, 100, 0, 0.8], 0.5).length === 6);
const stroke = { kind: 'pen', x: 10, y: 0, size: 4, points: new Float32Array([0, 0, 0.5, 100, 0, 0.5]) };
check('a hit test follows the stroke, where it was moved to', hits(stroke, 60, 3, 2) && !hits(stroke, 60, 20, 2) && !hits(stroke, 5, 0, 2));
check('the points pack into little-endian float32 triples', packPoints([1.5, -2, 0.25]).length === 12 && new DataView(packPoints([1.5, -2, 0.25]).buffer).getFloat32(4, true) === -2);

// --- devices: a room each, with the Whiteboard (and on A the Chat, which takes the exported PNG) ---

const code = newRoomCode();
const ice = () => ({ forRoom: null, adopt: () => false });

function makeCtx(letter, tool, handOffs) {
	const shows = new Set();
	const ctx = {
		room: letter.repeat(32), // its own storage key, so the devices in this one "browser" don't share a database
		notified: 0,
		shown: true,
		activate() {},
		notify() {
			if (!ctx.shown) ctx.notified++;
		},
		visible: () => ctx.shown,
		onShow(fn) {
			shows.add(fn);
			return () => shows.delete(fn);
		},
		show() {
			ctx.shown = true;
			shows.forEach(fn => fn());
		},
		handOff(to, file) {
			const fn = handOffs.get(to);
			if (!fn) return false;
			fn(file);
			return true;
		},
		onHandOff(fn) {
			handOffs.set(tool, fn);
			return () => handOffs.delete(tool);
		},
	};
	return ctx;
}

function device(name, letter, { withChat = false, start = true } = {}) {
	const id = letter.repeat(16);
	const room = new Room({ code, ice: ice(), identity: { id, name } });
	if (start) room.start();
	return mountOn({ name, id, letter, room, withChat });
}

function mountOn(dev) {
	const handOffs = new Map();
	dev.root = document.createElement('section');
	document.querySelector('.app').append(dev.root);
	dev.ctx = makeCtx(dev.letter, 'whiteboard', handOffs);
	dev.unmount = whiteboard.mount(dev.root, dev.room, dev.ctx);
	if (dev.withChat) {
		dev.chatRoot = document.createElement('section');
		document.querySelector('.app').append(dev.chatRoot);
		dev.unmountChat = chat.mount(dev.chatRoot, dev.room, makeCtx(dev.letter, 'chat', handOffs));
	}
	return dev;
}

const stageOf = dev => dev.root.querySelector('.wb-stage');
const boardName = dev => (stageOf(dev) && !stageOf(dev).hidden ? dev.root.querySelector('.doc-switch .doc-name')?.textContent : null);
const liveOf = dev => dev.root.querySelectorAll('.wb-canvas')[1].getContext('2d');
const baseOf = dev => dev.root.querySelectorAll('.wb-canvas')[0].getContext('2d');
const tool = (dev, label) => byLabel(dev.root, label).click();

/** What the device's board list says about the open board ("3 strokes, 1 image"). */
function counts(dev) {
	dev.root.querySelector('.doc-switch').click();
	const sheet = lastDialog();
	const text = sheet.querySelector('.doc-item[aria-current="true"] .doc-item-meta')?.firstChild?.textContent ?? '';
	sheet.close();
	return text;
}

function pointer(dev, type, { id = 1, x, y, kind = 'mouse', pressure = 0.5, button = 0 }) {
	stageOf(dev).dispatchEvent(new window.PointerEvent(type, {
		pointerId: id, pointerType: kind, clientX: x, clientY: y, pressure, button, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true,
	}));
}

/** Press, move in steps (waiting `pause` ms between them), and optionally lift. */
async function drag(dev, from, to, { steps = 10, pause = 5, up = true, pressures = null, ...opts } = {}) {
	pointer(dev, 'pointerdown', { ...opts, x: from[0], y: from[1], pressure: pressures?.[0] ?? opts.pressure });
	for (let i = 1; i <= steps; i++) {
		if (pause) await sleep(pause);
		const t = i / steps;
		pointer(dev, 'pointermove', { ...opts, x: from[0] + (to[0] - from[0]) * t, y: from[1] + (to[1] - from[1]) * t, pressure: pressures?.[i] ?? opts.pressure });
	}
	if (up) pointer(dev, 'pointerup', { ...opts, x: to[0], y: to[1] });
}

function key(dev, name, mods = {}) {
	stageOf(dev).dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...mods }));
}

function paste(target, files) {
	const e = new window.Event('paste', { bubbles: true, cancelable: true });
	Object.defineProperty(e, 'clipboardData', { value: { files, items: [] } });
	target.dispatchEvent(e);
	return e;
}

const A = device('Laptop', 'a', { withChat: true });
await sleep(60); // A holds the room before the others look for it
// B and C join at the same moment: each is welcomed before the other is a member, and they find each other through A.
const B = device('Phone', 'b');
const C = device('Tablet', 'c');
await until('three devices share a room', () => [A, B, C].every(dev => dev.room.members.length === 2), 8000, () => [A, B, C].map(dev => `${dev.name}: ${dev.room.state} ${dev.room.members.map(m => m.name)}`).join('; '));

// A headless member: its own board document, to watch what the others send and to write what they shouldn't.
const desk = new Room({ code, ice: ice(), identity: { id: 'd'.repeat(16), name: 'Desk' } });
desk.start();
const deskDoc = new RoomDoc(desk, 'd'.repeat(32), { name: boardDocName('d'.repeat(32)), channel: CH.BOARD, awareness: true });
await deskDoc.load();
deskDoc.awareness.setLocalState({ user: { name: 'Desk', color: '#5c7cfa' }, board: null });
const deskBoards = new Boards(deskDoc.lib, deskDoc.doc, 'd'.repeat(16));
await until('with a fourth, headless member', () => desk.members.length === 3, 8000);
const liveStrokes = () => [...deskDoc.awareness.getStates().values()].filter(state => state?.stroke).map(state => state.user.name).sort();
const itemsOnDesk = id => deskBoards.items(id);

// --- a first board ---

await until('an empty whiteboard offers a new board', () => [A, B, C].every(dev => buttonByText(dev.root, 'New board') && stageOf(dev).hidden));
check('and says images can be pasted', A.root.querySelector('.editor-message').textContent.includes('paste pictures from the clipboard'));
buttonByText(A.root, 'New board').click();
check('New board opens a board named Board 1', boardName(A) === 'Board 1');
await until('the others open it by themselves', () => boardName(B) === 'Board 1' && boardName(C) === 'Board 1');
const boardId = deskBoards.list()[0]?.id;
check('the headless member has it too', deskBoards.list().length === 1 && Boolean(boardId));
check('nothing to undo yet', byLabel(C.root, 'Undo (Ctrl+Z)').disabled && byLabel(C.root, 'Redo (Ctrl+Shift+Z)').disabled);

// A draws a straight line with the mouse. Every board opened empty, so a point on screen is the same board point
// on every device: the view starts 40 px up and left of the board's origin.
liveOf(B).ops = [];
await drag(A, [100, 100], [300, 100], { steps: 20, up: false });
await until('while A draws, the others see the stroke in progress', () => liveStrokes().includes('Laptop'));
await until('and B draws it on top of its board', () => liveOf(B).ops.some(op => op[0] === 'stroke' && op[1] === '#1e1e1e'));
check('nothing is stored before the pen lifts', itemsOnDesk(boardId).length === 0);
pointer(A, 'pointerup', { x: 300, y: 100 });
await until('the finished stroke is on every device', () => itemsOnDesk(boardId).length === 1 && [A, B, C].every(dev => counts(dev) === '1 stroke'));
await until('and the stroke in progress is gone', () => !liveStrokes().includes('Laptop'));
let first = itemsOnDesk(boardId)[0];
check('a straight line is stored simplified, as its two ends', first.points.length === 6 && first.points[0] === 60 && first.points[3] === 260, [...first.points].join());
check('with the pen’s colour and size, by A', first.kind === 'pen' && first.color === '#1e1e1e' && first.size === 4 && first.map.get('from') === A.id);
check('A can undo it; B, who didn’t draw it, can’t', !byLabel(A.root, 'Undo (Ctrl+Z)').disabled && byLabel(B.root, 'Undo (Ctrl+Z)').disabled);

// Three devices at once: a mouse, a finger and a stylus with pressure.
const pressures = Array.from({ length: 11 }, (_, i) => 0.2 + 0.7 * Math.sin((Math.PI * i) / 10)); // light, hard, light
await Promise.all([
	drag(A, [100, 200], [300, 260], { up: false, pause: 10 }),
	drag(B, [100, 300], [300, 380], { up: false, pause: 10, kind: 'touch', id: 5 }),
	drag(C, [100, 400], [300, 440], { up: false, pause: 10, kind: 'pen', id: 9, pressures }),
]);
await until('three devices draw at once, and all three strokes show while being drawn', () => liveStrokes().join() === 'Laptop,Phone,Tablet', 5000, () => liveStrokes().join());
pointer(A, 'pointerup', { x: 300, y: 260 });
pointer(B, 'pointerup', { id: 5, kind: 'touch', x: 300, y: 380 });
pointer(C, 'pointerup', { id: 9, kind: 'pen', x: 300, y: 440 });
await until('then all three are on every device', () => itemsOnDesk(boardId).length === 4 && [A, B, C].every(dev => counts(dev) === '4 strokes'));
const byDevice = dev => itemsOnDesk(boardId).filter(item => item.map.get('from') === dev.id);
const penStroke = byDevice(C)[0];
const strokePressures = [];
for (let i = 2; i < penStroke.points.length; i += 3) strokePressures.push(Math.round(penStroke.points[i] * 100) / 100);
check('a stylus stroke on a straight line keeps where it was pressed harder', strokePressures.length >= 5 && Math.max(...strokePressures) > 0.85 && strokePressures[0] < 0.25 && strokePressures.at(-1) < 0.25, strokePressures.join());
check('a finger and a mouse draw evenly', byDevice(B)[0].points.every((v, i) => i % 3 !== 2 || v === 0.5));
baseOf(A).ops = [];
stageOf(A).dispatchEvent(new window.WheelEvent('wheel', { deltaY: 0, bubbles: true, cancelable: true }));
await until('(A draws its board again)', () => baseOf(A).ops.some(op => op[0] === 'stroke'));
const widths = baseOf(A).ops.filter(op => op[0] === 'stroke' && op[3] === 1).map(op => op[2]);
check('the stylus stroke is drawn thin to thick to thin', new Set(widths).size > 6 && Math.max(...widths) > 5.5 && Math.min(...widths) < 3, `${Math.min(...widths)}–${Math.max(...widths)}`);

// Undo on one device takes back only its own stroke.
byLabel(B.root, 'Undo (Ctrl+Z)').click();
await until('undo on B removes B’s stroke on every device', () => byDevice(B).length === 0 && [A, B, C].every(dev => counts(dev) === '3 strokes'));
check('and only B’s', byDevice(A).length === 2 && byDevice(C).length === 1);
check('B can redo it', !byLabel(B.root, 'Redo (Ctrl+Shift+Z)').disabled);
key(B, 'z', { ctrlKey: true, shiftKey: true });
await until('Ctrl+Shift+Z brings it back everywhere', () => byDevice(B).length === 1 && counts(C) === '4 strokes');
key(C, 'z', { ctrlKey: true });
await until('Ctrl+Z on C takes back C’s stylus stroke, not A’s newer one', () => byDevice(C).length === 0 && byDevice(A).length === 2);
key(C, 'y', { ctrlKey: true });
await until('Ctrl+Y redoes it', () => byDevice(C).length === 1);

// The highlighter.
key(A, 'h');
check('H picks the highlighter', byLabel(A.root, 'Highlighter (H)').getAttribute('aria-pressed') === 'true');
await drag(A, [100, 500], [300, 500]);
await until('a highlighter stroke arrives, yellow and wide', () => itemsOnDesk(boardId).at(-1)?.kind === 'highlighter');
const marker = itemsOnDesk(boardId).at(-1);
check('with the highlighter’s own colour and size', marker.color === '#fcc419' && marker.size === 20);
await until('and it is drawn see-through, blending with what is under it', () => baseOf(C).ops.some(op => op[0] === 'stroke' && op[1] === '#fcc419' && op[3] < 1 && op[4] === 'multiply'));

// Colour and size: a popover; picking in it means drawing with that pen.
byLabel(A.root, 'Colour and size').click();
const popover = A.root.querySelector('.wb-popover');
check('the colour and size popover opens for the highlighter', !popover.hidden && byLabel(popover, 'Highlighter colour') !== null);
key(A, 'p');
check('the popover follows the tool it is for', byLabel(popover, 'Pen colour') !== null);
byLabel(popover, 'Red').click();
byLabel(popover, 'Thick').click();
check('a colour and a size are picked', byLabel(popover, 'Red').getAttribute('aria-pressed') === 'true' && byLabel(popover, 'Thick').getAttribute('aria-pressed') === 'true');
pointer(A, 'pointerdown', { x: 500, y: 500 });
check('a press on the board only closes the popover', popover.hidden);
pointer(A, 'pointerup', { x: 500, y: 500 });
await drag(A, [100, 540], [140, 580]);
await until('the next stroke is red and thick', () => itemsOnDesk(boardId).at(-1)?.color === '#e03131' && itemsOnDesk(boardId).at(-1)?.size === 8);
check('and the choice is kept on the device', JSON.parse(localStorage.getItem('peerkit.whiteboard')).pen.color === '#e03131');

// The eraser, across B's stroke (from board (60, 260) to (260, 340)).
const before = itemsOnDesk(boardId).length;
tool(A, 'Eraser (E)');
await drag(A, [200, 320], [200, 400]);
await until('the eraser takes the stroke it crossed off every device', () => byDevice(B).length === 0 && itemsOnDesk(boardId).length === before - 1);
key(A, 'z', { ctrlKey: true });
await until('undoing the erase brings it back, though B drew it', () => byDevice(B).length === 1 && itemsOnDesk(boardId).length === before);

// A pinch on the phone zooms and draws nothing, even though its first finger started a stroke.
const beforePinch = itemsOnDesk(boardId).length;
pointer(B, 'pointerdown', { id: 11, kind: 'touch', x: 200, y: 150 });
pointer(B, 'pointermove', { id: 11, kind: 'touch', x: 205, y: 150 });
await sleep(20);
pointer(B, 'pointerdown', { id: 12, kind: 'touch', x: 305, y: 150 }); // 100 px apart
for (let i = 1; i <= 10; i++) {
	pointer(B, 'pointermove', { id: 11, kind: 'touch', x: 205 - i * 5, y: 150 });
	pointer(B, 'pointermove', { id: 12, kind: 'touch', x: 305 + i * 5, y: 150 });
	await sleep(5);
}
pointer(B, 'pointerup', { id: 12, kind: 'touch', x: 355, y: 150 }); // 200 px apart: twice as close
await drag(B, [155, 150], [120, 150], { id: 11, kind: 'touch', steps: 3, pause: 0 }); // the finger still down does nothing
await sleep(150);
check('a pinch draws nothing', itemsOnDesk(boardId).length === beforePinch && !liveStrokes().includes('Phone'));
// It zoomed ×2: a 100 px line on the phone is 50 board units now.
await drag(B, [100, 600], [200, 600], { id: 13, kind: 'touch' });
await until('the pinch zoomed in: a stroke after it is half as long on the board', () => itemsOnDesk(boardId).length === beforePinch + 1);
const zoomed = itemsOnDesk(boardId).at(-1);
check('(100 px on screen → 50 on the board)', Math.abs(zoomed.points.at(-3) - zoomed.points[0] - 50) < 1, `${zoomed.points[0]} → ${zoomed.points.at(-3)}`);

// Once a stylus has drawn, a finger pans instead: a palm on the screen draws nothing.
const beforePalm = itemsOnDesk(boardId).length;
await drag(C, [400, 100], [450, 150], { id: 21, kind: 'touch' });
await sleep(100);
check('after the stylus, a finger on the tablet pans instead of drawing', itemsOnDesk(boardId).length === beforePalm);

// --- drawing offline, then meeting again ---

C.unmount();
await C.room.leave();
const offline = mountOn({ name: 'Tablet', id: C.id, letter: 'c', room: new Room({ code, ice: ice(), identity: { id: C.id, name: 'Tablet' } }) });
await until('offline, the tablet has the board from its own storage', () => boardName(offline) === 'Board 1' && counts(offline) === counts(A), 5000, () => `${counts(offline)} / ${counts(A)}`);
tool(offline, 'Pen (P)');
await drag(offline, [300, 300], [350, 300], { kind: 'mouse' });
tool(A, 'Pen (P)');
await drag(A, [100, 700], [200, 700]);
await until('meanwhile A draws as well', () => byDevice(A).length === 5);
await sleep(200); // let IndexedDB take the offline stroke
check('apart, the others don’t have the offline stroke', byDevice(C).length === 1);
offline.unmount();
const back = device('Tablet', 'c');
await until('back online, the strokes drawn apart merge on both sides', () => boardName(back) === 'Board 1' && counts(back) === counts(A) && byDevice(C).length === 2, 8000, () => `${counts(back)} / ${counts(A)}`);

// Chrome sometimes takes the capture away just before a mouse button is released: the stroke stays all the same.
const beforeLost = itemsOnDesk(boardId).length;
await drag(A, [100, 740], [250, 760], { up: false });
stageOf(A).dispatchEvent(new window.PointerEvent('lostpointercapture', { pointerId: 1, pointerType: 'mouse', bubbles: true }));
pointer(A, 'pointerup', { x: 250, y: 760 });
await until('a stroke that loses its capture just before the release is kept on every device', () => itemsOnDesk(boardId).length === beforeLost + 1 && counts(back) === counts(A));
await until('and is no longer in progress', () => !liveStrokes().includes('Laptop'));
await drag(A, [100, 780], [200, 780]);
await until('the next stroke draws as usual', () => itemsOnDesk(boardId).length === beforeLost + 2);
// A touch the browser takes over is still dropped.
await drag(B, [100, 650], [200, 650], { id: 15, kind: 'touch', up: false });
pointer(B, 'pointercancel', { id: 15, kind: 'touch', x: 200, y: 650 });
stageOf(B).dispatchEvent(new window.PointerEvent('lostpointercapture', { pointerId: 15, pointerType: 'touch', bubbles: true }));
await sleep(150);
check('a touch the browser cancels draws nothing', itemsOnDesk(boardId).length === beforeLost + 2 && !liveStrokes().includes('Phone'));

// --- images ---

// Ctrl+V with a screenshot on the clipboard.
tool(A, 'Pen (P)');
const shot = fakeImage(800, 600, { type: 'image/png' });
const pasted = paste(stageOf(A), [new File([shot], 'image.png', { type: 'image/png' })]);
check('a pasted image is taken by the board', pasted.defaultPrevented);
await until('it appears on every device', () => itemsOnDesk(boardId).some(item => item.kind === 'image') && [A, B, back].every(dev => counts(dev).endsWith('1 image')));
let image = itemsOnDesk(boardId).find(item => item.kind === 'image');
check('a small screenshot is kept as it is, as PNG', sizeOf(image.data)?.join('x') === '800x600' && image.data.length === 240000);
check('in the middle of the view, at most 60 % of it, in proportion', image.x === 120 && image.y === 80 && image.w === 480 && image.h === 360, `${image.x},${image.y} ${image.w}×${image.h}`);
check('the pasted image is selected, with the select tool', byLabel(A.root, 'Select and move (V)').getAttribute('aria-pressed') === 'true' && !byLabel(A.root, 'Delete the selection (Delete)').hidden);
await until('B draws the image, not a grey box', () => baseOf(B).ops.some(op => op[0] === 'drawImage' && op[4] === 480));

// A paste meant for a text field stays there.
const input = document.createElement('input');
document.body.append(input);
const elsewhere = paste(input, [new File([shot], 'image.png', { type: 'image/png' })]);
await sleep(100);
check('a paste into a text field is left alone', !elsewhere.defaultPrevented && counts(A).endsWith('1 image'));
input.remove();

// Move it, then resize it by its corner (the image is at screen 160–640 × 120–480).
await drag(A, [400, 300], [450, 330], { steps: 5 });
await until('dragging the image moves it on every device', () => {
	const moved = itemsOnDesk(boardId).find(item => item.kind === 'image');
	return moved.x === 170 && moved.y === 110;
});
await drag(A, [690, 510], [738, 540], { steps: 4 });
await until('its corner handle resizes it, in proportion', () => {
	const sized = itemsOnDesk(boardId).find(item => item.kind === 'image');
	return sized.w === 528 && sized.h === 396;
});
key(A, 'z', { ctrlKey: true });
await until('undo puts the old size back', () => itemsOnDesk(boardId).find(item => item.kind === 'image').w === 480);

// The Paste button reads the clipboard through the Clipboard API; a big photo is made smaller.
clipboard = [fakeImage(6000, 4000, { type: 'image/jpeg' })];
tool(A, 'Add an image');
check('the image button offers Paste and Choose', Boolean(buttonByText(A.root, 'Paste image')) && Boolean(buttonByText(A.root, 'Choose image')));
buttonByText(A.root, 'Paste image').click();
await until('Paste image adds the photo from the clipboard', () => itemsOnDesk(boardId).filter(item => item.kind === 'image').length === 2);
image = itemsOnDesk(boardId).filter(item => item.kind === 'image')[1];
check('a 6000 × 4000 photo is stored smaller than 1 MB, at most 2560 wide', image.data.length <= 1024 * 1024 && sizeOf(image.data)[0] <= 2560 && sizeOf(image.data).join('x') === '1920x1280', `${sizeOf(image.data)?.join('x')}, ${image.data.length} bytes`);
clipboard = [new Blob(['just text'], { type: 'text/plain' })];
tool(A, 'Add an image');
buttonByText(A.root, 'Paste image').click();
await until('a clipboard without an image says so', () => toasts().includes('There is no image on the clipboard'));

// Delete the selected photo with the Delete key.
key(A, 'Delete');
await until('Delete removes the selected image on every device', () => itemsOnDesk(boardId).filter(item => item.kind === 'image').length === 1 && counts(B).endsWith('1 image'));

// A file that isn't an image, from the file picker.
const picker = A.root.querySelector('.whiteboard input[type=file]');
Object.defineProperty(picker, 'files', { value: [new File(['not an image'], 'notes.png', { type: 'image/png' })], configurable: true });
picker.dispatchEvent(new window.Event('change'));
await until('a file that isn’t really an image is refused', () => toasts().includes('Could not read the image'));

// A drop onto the board goes onto the board, not into the chat's send sheet.
const drop = new window.MouseEvent('drop', { clientX: 540, clientY: 440, bubbles: true, cancelable: true });
Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File([fakeImage(200, 100)], 'badge.png', { type: 'image/png' })], items: [], types: ['Files'] } });
stageOf(A).dispatchEvent(drop);
await until('a dropped image lands where it was dropped', () => {
	const dropped = itemsOnDesk(boardId).find(item => item.kind === 'image' && item.w === 200);
	return dropped && dropped.x === 400 && dropped.y === 350;
});
check('and the chat didn’t take it', !lastDialog());

// --- the board list ---

B.root.querySelector('.doc-switch').click();
buttonByText(lastDialog(), 'New board').click();
await until('B makes a second board and opens it', () => boardName(B) === 'Board 2');
check('A stays on its board', boardName(A) === 'Board 1');
byLabel(B.root, 'Board options').click();
const nameInput = lastDialog().querySelector('input.input');
nameInput.value = 'Sketches';
lastDialog().close();
await until('a rename reaches the others’ list', () => {
	A.root.querySelector('.doc-switch').click();
	const listed = [...lastDialog().querySelectorAll('.doc-item-name')].map(el => el.textContent);
	lastDialog().close();
	return listed.join() === 'Board 1,Sketches';
});
A.root.querySelector('.doc-switch').click();
const sketchesItem = [...lastDialog().querySelectorAll('.doc-item')].find(item => item.textContent.includes('Sketches'));
check('the list shows who is on which board', sketchesItem.querySelector('.presence-chip')?.textContent === 'Phone', sketchesItem.textContent);
sketchesItem.click();
await until('A switches to it from the list', () => boardName(A) === 'Sketches');
byLabel(A.root, 'Board options').click();
buttonByText(lastDialog(), 'Delete').click();
await until('deleting it moves both back to Board 1', () => boardName(A) === 'Board 1' && boardName(B) === 'Board 1');
check('and B is told who deleted it', toasts().includes('Laptop deleted “Sketches”'));

// --- export ---

const board = itemsOnDesk(boardId);
byLabel(A.root, 'Board options').click();
buttonByText(lastDialog(), 'Send to Chat').click();
await until('Send to Chat hands a PNG of the board to the chat’s send sheet', () => lastDialog()?.textContent.includes('Board 1.png'));
check('the sheet is the chat’s, with Keep for the room', lastDialog().textContent.includes('Keep for the room'));
buttonByText(lastDialog(), 'Cancel').click();
const exported = contexts.filter(ctx => !ctx.canvas.isConnected).at(-1);
const box = unionBounds(board.map(itemBounds));
check('the PNG covers the whole drawing with a margin, two pixels to a unit', exported.canvas.width === Math.ceil((box.maxX - box.minX + 48) * 2) && exported.canvas.height === Math.ceil((box.maxY - box.minY + 48) * 2), `${exported.canvas.width}×${exported.canvas.height}`);
const transform = exported.ops.find(op => op[0] === 'setTransform');
check('drawn from the drawing’s corner', transform[1] === 2 && transform[5] === (24 - box.minX) * 2 && transform[6] === (24 - box.minY) * 2);
check('with every image of the board, where it is', board.filter(item => item.kind === 'image').every(item => exported.ops.some(op => op[0] === 'drawImage' && op[2] === item.x && op[3] === item.y && op[4] === item.w && op[5] === item.h)));
check('and every stroke', exported.ops.filter(op => op[0] === 'stroke').length >= board.filter(item => item.kind !== 'image').length);
byLabel(A.root, 'Board options').click();
buttonByText(lastDialog(), 'Download PNG').click();
await until('Download PNG saves it', () => downloads.includes('Board 1.png'));
lastDialog().close();

// --- what a member shouldn't send ---

const beforeForged = counts(A);
const { Y } = deskDoc.lib;
deskDoc.doc.transact(() => {
	const items = deskDoc.doc.getMap('boards').get(boardId).get('items');
	const map = fields => {
		const m = new Y.Map();
		for (const [k, v] of Object.entries(fields)) m.set(k, v);
		return m;
	};
	items.push([
		map({ kind: 'script', x: 0, y: 0 }),
		map({ kind: 'pen', x: 0, y: 0, color: '#000000', size: 4, points: new Uint8Array(7) }),
		map({ kind: 'pen', x: 0, y: 0, color: '#000000', size: 4, points: packPoints([Number.NaN, 0, 0.5, 1, 1, 0.5]) }),
		map({ kind: 'pen', x: 0, y: 0, color: '#000000', size: 1e9, points: packPoints([0, 0, 0.5]) }),
		map({ kind: 'image', x: 0, y: 0, w: 10, h: 10, data: 'not bytes' }),
		map({ kind: 'image', x: 'far', y: 0, w: 10, h: 10, data: new Uint8Array(8) }),
		'just a string',
		42,
	]);
});
deskDoc.awareness.setLocalState({ user: { name: '<b>Desk</b>', color: 'javascript:alert(1)' }, board: boardId, pointer: ['a', 1], stroke: { kind: 'pen', color: '#000000', size: 4, points: [1, 2, 'x'] } });
await sleep(300);
check('forged items are left out, and nothing breaks', counts(A) === beforeForged && counts(B) === beforeForged, `${counts(A)} / ${beforeForged}`);
const chip = [...A.root.querySelectorAll('.presence-chip')].find(el => el.textContent.includes('Desk'));
check('a member’s name shows as text, with a safe colour', chip?.textContent === '<b>Desk</b>' && !chip.querySelector('b') && chip.getAttribute('style').includes('#0c8599'));
deskDoc.awareness.setLocalState({ user: { name: 'Desk', color: '#5c7cfa' }, board: null });

// --- the unread mark, and leaving the page ---

A.ctx.shown = false;
await drag(B, [100, 650], [150, 650], { id: 14, kind: 'touch' });
await until('a stroke while the whiteboard is out of sight marks its tab', () => A.ctx.notified > 0);
A.ctx.show();

await sleep(100);
A.unmount();
A.unmountChat();
B.unmount();
back.unmount();
deskDoc.destroy();
for (const room of [A.room, B.room, back.room, desk]) await room.leave();
await sleep(50);
check('no errors logged', errors.length === 0, errors.slice(0, 3).join(' | '));
check('no warnings logged', warnings.length === 0, warnings.slice(0, 3).join(' | '));
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
