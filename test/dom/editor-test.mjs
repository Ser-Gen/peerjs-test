// DOM smoke test: two real Editor tools in jsdom, linked by fake sessions.
const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, ''); // the repo root
const { JSDOM } = await import('jsdom');

const dom = new JSDOM('<!doctype html><html><body><div class="app"><div id="toasts"></div></div></body></html>', {
	url: 'https://peerkit.test/',
	pretendToBeVisual: true,
});
const { window } = dom;
const errors = [];
const origError = console.error;
console.error = (...args) => {
	errors.push(args.map(String).join(' '));
	origError(...args);
};
process.on('unhandledRejection', err => errors.push(`unhandled rejection: ${err?.stack ?? err}`));
window.addEventListener('error', e => errors.push(`window error: ${e.message}`));

// Browser globals the app and CodeMirror expect.
const expose = ['window', 'Window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history',
	'HTMLElement', 'HTMLDialogElement', 'HTMLAnchorElement', 'HTMLInputElement', 'Element', 'Node', 'Text', 'DocumentFragment',
	'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'Range', 'Selection',
	'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'InputEvent', 'FocusEvent', 'CompositionEvent', 'DOMParser'];
for (const key of expose) Object.defineProperty(globalThis, key, { value: key === 'window' ? window : window[key], configurable: true, writable: true });
const media = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.matchMedia = globalThis.matchMedia = media;
window.confirm = globalThis.confirm = () => true;
window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
window.HTMLDialogElement.prototype.close = function () {
	if (!this.hasAttribute('open')) return;
	this.removeAttribute('open');
	this.dispatchEvent(new window.Event('close'));
};
window.Range.prototype.getClientRects = () => [];
window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
window.HTMLElement.prototype.scrollIntoView ??= () => {};
const downloads = [];
window.HTMLAnchorElement.prototype.click = function () {
	if (this.hasAttribute('download')) downloads.push(this.getAttribute('download'));
};
await import('fake-indexeddb/auto');
// fake-indexeddb installs itself on `window` (jsdom's), but the bundle reads the bare globals.
for (const key of Object.getOwnPropertyNames(window).filter(k => /^(indexedDB|IDB)/.test(k))) {
	Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}

const { Emitter } = await import(`${ROOT}/app/emitter.js`);
const { default: editorTool } = await import(`${ROOT}/app/tools/editor/editor.js`);
const lib = await import(`${ROOT}/vendor/editor.js`);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let failures = 0;
function check(name, ok, extra = '') {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
	if (!ok) failures++;
}
async function until(name, fn, ms = 4000) {
	const start = Date.now();
	for (;;) {
		let value;
		try {
			value = fn();
		} catch {
			value = false;
		}
		if (value) return check(name, true, `${Date.now() - start} ms`);
		if (Date.now() - start > ms) {
			const show = root => root.querySelector('.editor')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 160);
			return check(name, false, `timed out; A shows "${show(rootA)}", B shows "${show(rootB)}"`);
		}
		await sleep(10);
	}
}

class FakeRoom extends Emitter {
	constructor(name, color) {
		super();
		this.self = { peerId: `pk-m-${name}`, name, deviceId: name, color };
		this.peer = null;
		this.up = false;
	}
	get members() {
		return this.up && this.peer ? [{ ...this.peer.self }] : [];
	}
	member(peerId) {
		return this.members.find(m => m.peerId === peerId) ?? null;
	}
	controlBuffered() {
		return 0;
	}
	isLinked(x, y) {
		return this.up && [this.self.peerId, this.peer.self.peerId].includes(x) && [this.self.peerId, this.peer.self.peerId].includes(y);
	}
	send(ch, msg, to = null) {
		if (!this.up || !this.peer || (to && to !== this.peer.self.peerId)) return 0;
		const json = JSON.stringify({ ...msg, ch });
		if (json.length >= 16300) throw new Error(`message too big: ${json.length}`);
		const peer = this.peer;
		setTimeout(() => {
			if (!peer.up || !this.up) return;
			const parsed = JSON.parse(json);
			peer.emit(`msg:${parsed.ch}`, parsed, { ...this.self });
		}, 0);
		return 1;
	}
	setUp(up) {
		this.up = up;
		this.emit(up ? 'link-up' : 'link-down', { ...this.peer.self }, up ? null : 'lost');
		this.emit('members');
	}
}

function makeCtx(room, visible) {
	const listeners = new Set();
	const ctx = {
		room,
		notified: 0,
		shown: visible,
		activate() {},
		notify() {
			if (!ctx.shown) ctx.notified++;
		},
		visible: () => ctx.shown,
		onShow(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		show() {
			ctx.shown = true;
			listeners.forEach(fn => fn());
		},
	};
	return ctx;
}

const buttonByText = (root, text) => [...root.querySelectorAll('button')].find(b => b.textContent.trim().includes(text));
const byLabel = (root, label) => root.querySelector(`[aria-label="${label}"]`);
const lastDialog = () => [...document.querySelectorAll('dialog[open]')].at(-1);
const viewOf = root => lib.EditorView.findFromDOM(root.querySelector('.cm-editor'));
const textIn = root => viewOf(root)?.state.doc.toString();
const docName = root => root.querySelector('.doc-name')?.textContent;
function change(el, value) {
	el.value = value;
	el.dispatchEvent(new window.Event('change', { bubbles: true }));
}

const rootA = document.createElement('section');
const rootB = document.createElement('section');
document.querySelector('.app').append(rootA, rootB);
const sA = new FakeRoom('A', '#e8590c');
const sB = new FakeRoom('B', '#0c8599');
sA.peer = sB;
sB.peer = sA;
sA.up = sB.up = true;
const ctxA = makeCtx('fox-42@server-a', true);
const ctxB = makeCtx('fox-42@server-b', false); // different rooms: separate IndexedDB databases in this one "browser"

let unmountA = editorTool.mount(rootA, sA, ctxA);
const unmountB = editorTool.mount(rootB, sB, ctxB);

await until('A (visible) loads and shows the empty state', () => rootA.querySelector('.editor-message:not([hidden])')?.textContent.includes('Write together'), 10000);
await until('B (tab never opened) loads because A started syncing', () => rootB.querySelector('.editor-message:not([hidden])')?.textContent.includes('Write together'), 10000);

buttonByText(rootA, 'New document').click();
await until('New document opens an editor on A', () => rootA.querySelector('.cm-editor') && docName(rootA) === 'Untitled');
await until('B opens the new document by itself', () => rootB.querySelector('.cm-editor') && docName(rootB) === 'Untitled');
check('B, hidden, got the notify dot', ctxB.notified > 0, `${ctxB.notified} notify calls`);

viewOf(rootA).dispatch({ changes: { from: 0, insert: 'hello from A' } });
await until('typing on A appears on B', () => textIn(rootB) === 'hello from A');

viewOf(rootA).dispatch({ changes: { from: viewOf(rootA).state.doc.length, insert: ' [A]' } });
viewOf(rootB).dispatch({ changes: { from: 0, insert: '[B] ' } });
await until('simultaneous edits converge on both', () => textIn(rootA) === textIn(rootB) && textIn(rootA) === '[B] hello from A [A]');

await until('presence chip shows the other device on both', () =>
	rootA.querySelector('.presence:not([hidden]) .presence-chip') && rootB.querySelector('.presence:not([hidden]) .presence-chip'));

byLabel(rootA, 'Undo').click();
await until('Undo on A removes only A\'s own typing, on both devices', () => textIn(rootA) === '[B] ' && textIn(rootB) === '[B] ');
byLabel(rootA, 'Redo').click();
await until('Redo brings it back on both', () => textIn(rootB) === '[B] hello from A [A]');

byLabel(rootA, 'Document options').click();
let sheet = lastDialog();
change(sheet.querySelector('input.input'), 'Shopping');
change(sheet.querySelector('select'), 'markdown');
buttonByText(sheet, 'Large').click();
check('text size applies right away', rootA.querySelector('.editor').style.getPropertyValue('--editor-font-size') === '18px');
buttonByText(sheet, 'Download').click();
check('Download names the file from name and language', downloads.at(-1) === 'Shopping.md', downloads.at(-1));
buttonByText(sheet, 'Done').click();
await until('rename reaches B', () => docName(rootB) === 'Shopping');

rootB.querySelector('.doc-switch').click();
sheet = lastDialog();
check('B\'s document list shows the new language', sheet.querySelector('.doc-item-meta')?.textContent.includes('Markdown'), sheet.querySelector('.doc-item-meta')?.textContent);
sheet.close();

const fileInput = rootA.querySelector('input[type=file]');
Object.defineProperty(fileInput, 'files', { value: [new File(['def f():\r\n    return 1\r\n'], 'tool.py')], configurable: true });
fileInput.dispatchEvent(new window.Event('change'));
await until('Open file creates a Python document on A with LF line endings', () => docName(rootA) === 'tool.py' && textIn(rootA) === 'def f():\n    return 1\n');
await sleep(50);
rootB.querySelector('.doc-switch').click();
sheet = lastDialog();
const pyItem = [...sheet.querySelectorAll('.doc-item')].find(b => b.textContent.includes('tool.py'));
check('the opened file is listed on B', pyItem?.textContent.includes('Python'), pyItem?.textContent);
pyItem.click();
await until('B switches to it from the list', () => docName(rootB) === 'tool.py' && textIn(rootB) === 'def f():\n    return 1\n');

// Link down: both edit, then reconnect.
sA.setUp(false);
sB.setUp(false);
await until('presence chips go away when the link drops', () => rootA.querySelector('.presence').hidden && rootB.querySelector('.presence').hidden);
viewOf(rootA).dispatch({ changes: { from: 0, insert: '# from A offline\n' } });
viewOf(rootB).dispatch({ changes: { from: viewOf(rootB).state.doc.length, insert: '# from B offline\n' } });
await sleep(50);
check('offline edits stay apart', textIn(rootA) !== textIn(rootB));
sA.setUp(true);
sB.setUp(true);
await until('offline edits merge after reconnect', () => textIn(rootA) === textIn(rootB) && textIn(rootA).startsWith('# from A offline\n') && textIn(rootA).endsWith('# from B offline\n'));
await until('presence comes back after reconnect', () => !rootA.querySelector('.presence').hidden && !rootB.querySelector('.presence').hidden);

// Delete on B while A has it open.
byLabel(rootB, 'Document options').click();
buttonByText(lastDialog(), 'Delete').click();
await until('delete on B moves B to the remaining document', () => docName(rootB) === 'Shopping');
await until('A is told and moves on too', () => document.getElementById('toasts').textContent.includes('B deleted “tool.py”') && docName(rootA) === 'Shopping');

// Reload A without a link: the documents come from IndexedDB.
await sleep(100);
unmountA();
check('unmount removes the tool', !rootA.querySelector('.editor'));
sA.setUp(false);
sB.setUp(false);
unmountA = editorTool.mount(rootA, sA, makeCtx('fox-42@server-a', true));
await until('after a reload the documents are still there (IndexedDB)', () => docName(rootA) === 'Shopping' && textIn(rootA) === '[B] hello from A [A]');

unmountA();
unmountB();
await sleep(50);
check('no errors logged', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
