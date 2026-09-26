// The Editor with Monaco chosen, in jsdom: A is the Editor tool in Monaco, B a member in CodeMirror (its Y.Doc,
// DocProvider and a CodeMirror view of its own), so a mixed room is checked both ways.
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
	const text = args.map(String).join(' ');
	errors.push(text);
	origError(...args);
};
process.on('unhandledRejection', err => {
	// The stub worker below never answers, so Monaco cancels what it asked it when a model goes.
	if (err?.name !== 'Canceled') errors.push(`unhandled rejection: ${err?.stack ?? err}`);
});
window.addEventListener('error', e => errors.push(`window error: ${e.message}`));

const expose = ['window', 'Window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history',
	'HTMLElement', 'HTMLDialogElement', 'HTMLAnchorElement', 'HTMLInputElement', 'Element', 'Node', 'Text', 'DocumentFragment',
	'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'Range', 'Selection',
	'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'InputEvent', 'FocusEvent', 'CompositionEvent', 'DOMParser',
	'ClipboardEvent', 'DragEvent', 'UIEvent', 'PointerEvent', 'WheelEvent', 'HTMLTextAreaElement', 'HTMLCanvasElement',
	'SVGElement', 'ShadowRoot', 'NodeFilter', 'getSelection', 'devicePixelRatio', 'screen', 'innerWidth', 'innerHeight'];
for (const key of expose) Object.defineProperty(globalThis, key, { value: key === 'window' ? window : window[key], configurable: true, writable: true });
// Monaco reads many more of them (customElements, the event classes…): the rest of jsdom's window too.
for (const key of Object.getOwnPropertyNames(window)) {
	if (key in globalThis) continue;
	try {
		globalThis[key] = window[key];
	} catch {}
}
// What Monaco expects of a browser page beyond jsdom.
globalThis.self = globalThis;
for (const key of ['addEventListener', 'removeEventListener', 'dispatchEvent']) globalThis[key] = window[key].bind(window);
window.document.queryCommandSupported = () => false;
window.document.execCommand = () => false;
// A 2D context that draws nothing (Monaco's overview ruler and text measuring), and a clipboard.
const context = new Proxy({}, {
	get: (target, key) => key === 'measureText' ? text => ({ width: String(text).length * 8 }) : key in target ? target[key] : () => {},
	set: (target, key, value) => ((target[key] = value), true),
});
window.HTMLCanvasElement.prototype.getContext = () => context;
globalThis.ClipboardItem = window.ClipboardItem = class { constructor(items) { this.items = items; } };
Object.defineProperty(window.navigator, 'clipboard', { value: { write: async () => {}, writeText: async () => {}, read: async () => [], readText: async () => '' }, configurable: true });
globalThis.ResizeObserver = window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
const workers = [];
globalThis.Worker = class {
	constructor(url) {
		workers.push(String(url));
	}
	postMessage() {}
	terminate() {}
	addEventListener() {}
	removeEventListener() {}
};
const media = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
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
await import('fake-indexeddb/auto');
for (const key of Object.getOwnPropertyNames(window).filter(k => /^(indexedDB|IDB)/.test(k))) {
	Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}

const { Emitter } = await import(`${ROOT}/app/emitter.js`);
const { DocProvider } = await import(`${ROOT}/app/docsync.js`);
const { editorPrefs } = await import(`${ROOT}/app/tools/editor/prefs.js`);
const { CodeMirrorView } = await import(`${ROOT}/app/tools/editor/cm-view.js`);
const { default: editorTool } = await import(`${ROOT}/app/tools/editor/editor.js`);
const yjs = await import(`${ROOT}/vendor/yjs.js`);
const cm = await import(`${ROOT}/vendor/editor.js`);
const { Y } = yjs;

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
			return check(name, false, `timed out; A shows "${rootA.querySelector('.editor')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 160)}"`);
		}
		await sleep(10);
	}
}

// Two members joined by a pipe that delivers JSON a tick later, as the room does.
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
		const peer = this.peer;
		setTimeout(() => {
			if (peer.up && this.up) peer.emit(`msg:${ch}`, JSON.parse(json), { ...this.self });
		}, 0);
		return 1;
	}
	setUp(up) {
		this.up = up;
		this.emit(up ? 'link-up' : 'link-down', { ...this.peer.self }, up ? null : 'lost');
		this.emit('members');
	}
}

const ctx = {
	room: 'owl-7@server',
	activate() {},
	notify() {},
	visible: () => true,
	onShow: () => () => {},
};

const rootA = document.createElement('section');
document.querySelector('.app').append(rootA);
const sA = new FakeRoom('A', '#e8590c');
const sB = new FakeRoom('B', '#0c8599');
sA.peer = sB;
sB.peer = sA;
sA.up = sB.up = true;

// B: the room's editor document, shown in CodeMirror the way the Editor shows it.
const docB = new Y.Doc();
const awarenessB = new yjs.awarenessProtocol.Awareness(docB);
awarenessB.setLocalState({ user: { name: 'B', color: '#0c8599', colorLight: '#0c859933' }, doc: null });
const providerB = new DocProvider({ lib: yjs, room: sB, doc: docB, awareness: awarenessB });
let viewB = null;
const hostB = document.createElement('div');
document.body.append(hostB);
const textB = () => viewB?.view.state.doc.toString();
function showOnB(id) {
	viewB?.destroy();
	const text = docB.getMap('docs').get(id).get('text');
	viewB = new CodeMirrorView(cm, { host: hostB, text, lang: 'text', awareness: awarenessB, undoManager: new Y.UndoManager(text), wrap: true, dark: false });
	awarenessB.setLocalStateField('doc', id);
	return text;
}

// A: the Editor with Monaco chosen in Settings.
editorPrefs.setEngine('monaco');
check('the choice is kept in peerkit.editor', JSON.parse(localStorage.getItem('peerkit.editor')).engine === 'monaco');
const unmountA = editorTool.mount(rootA, sA, ctx);
const { monaco } = await import(`${ROOT}/vendor/monaco.js`);
const editorA = () => monaco.editor.getEditors()[0];
const modelA = () => editorA()?.getModel();
const textA = () => modelA()?.getValue();
const byLabel = (root, label) => root.querySelector(`[aria-label="${label}"]`);
const buttonByText = (root, text) => [...root.querySelectorAll('button')].find(b => b.textContent.trim().includes(text));
const lastDialog = () => [...document.querySelectorAll('dialog[open]')].at(-1);
function type(text) {
	editorA().trigger('keyboard', 'type', { text });
}

await until('A shows the empty state', () => rootA.querySelector('.editor-message:not([hidden])')?.textContent.includes('Write together'), 10000);
buttonByText(rootA, 'New document').click();
await until('New document opens it in Monaco on A', () => rootA.querySelector('.monaco-editor') && !rootA.querySelector('.cm-editor'), 10000);
check('its stylesheet is added once', document.querySelectorAll('link[href$="vendor/monaco.css"]').length === 1);
check('the model uses \\n line breaks', modelA().getEOL() === '\n');
await until('B gets the document', () => docB.getMap('docs').size === 1);
const id = [...docB.getMap('docs').keys()][0];
const ytextB = showOnB(id);

editorA().focus();
editorA().setPosition({ lineNumber: 1, column: 1 });
type('hello from A');
await until('typing in Monaco reaches CodeMirror on B', () => textB() === 'hello from A');
viewB.view.dispatch({ changes: { from: 0, insert: '[B] ' } });
await until('typing in CodeMirror on B reaches Monaco on A', () => textA() === '[B] hello from A');
check('and the cursor on A moved along with the text before it', editorA().getPosition().column === 17, editorA().getPosition().toString());
type(' [A]');
viewB.view.dispatch({ changes: { from: 0, insert: '(' } });
await until('edits at the same moment come out the same on both', () => textA() === textB() && textA() === '([B] hello from A [A]');

// Several lines, a replace spanning them, and text that arrives in pieces.
type('\none\ntwo\nthree');
await until('lines typed on A reach B', () => textB() === '([B] hello from A [A]\none\ntwo\nthree');
viewB.view.dispatch({ changes: [{ from: 22, to: 29, insert: 'ONE\nTWO' }, { from: textB().length, insert: '\nfour' }] });
await until('a multi-line replace and an insert from B at once', () => textA() === '([B] hello from A [A]\nONE\nTWO\nthree\nfour');
check('offsets agree after it', modelA().getValueLength() === ytextB.length);

// Undo: the document's Y.UndoManager, so only A's own typing goes.
byLabel(rootA, 'Undo').click();
await sleep(50);
byLabel(rootA, 'Undo').click();
byLabel(rootA, 'Undo').click();
await until('Undo on A takes back only what A typed, on both devices', () => !textA().includes('A]') && !textA().includes('one') && textA().includes('[B]') && textB() === textA(), 4000);
byLabel(rootA, 'Redo').click();
byLabel(rootA, 'Redo').click();
byLabel(rootA, 'Redo').click();
await until('Redo brings it back on both', () => textA() === '([B] hello from A [A]\nONE\nTWO\nthree\nfour' && textB() === textA());

// Cursors: the same awareness field as CodeMirror's, so each sees the other.
editorA().focus();
editorA().setSelection(new monaco.Selection(1, 2, 1, 5));
await until('A\'s selection reaches B as a cursor B can place', () => {
	const state = [...awarenessB.getStates()].find(([client]) => client !== docB.clientID)?.[1];
	const anchor = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(state.cursor.anchor), docB);
	const head = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(state.cursor.head), docB);
	return anchor.index === 1 && head.index === 4;
});
awarenessB.setLocalStateField('cursor', {
	anchor: Y.createRelativePositionFromTypeIndex(ytextB, 5),
	head: Y.createRelativePositionFromTypeIndex(ytextB, 10),
});
// jsdom lays out no lines, so the selection is checked as the model's decoration.
const remoteSelection = () => modelA().getAllDecorations().find(d => /peerkit-yhead/.test(`${d.options.afterContentClassName} ${d.options.beforeContentClassName}`));
await until('B\'s selection shows on A with B\'s name', () => {
	const found = remoteSelection();
	return rootA.querySelector('.peerkit-yname')?.textContent === 'B'
		&& modelA().getOffsetAt(found.range.getStartPosition()) === 5 && modelA().getOffsetAt(found.range.getEndPosition()) === 10
		&& [...document.querySelectorAll('style')].some(s => s.textContent.includes('#0c859933'));
});
viewB.view.dispatch({ changes: { from: 0, insert: '12' } });
await until('and moves along with the text', () => modelA().getOffsetAt(remoteSelection()?.range.getStartPosition()) === 7);
check('in B\'s colour', rootA.querySelector('.peerkit-yname').style.backgroundColor.replace(/\s/g, '') === 'rgb(12,133,153)');
awarenessB.setLocalStateField('user', { name: 'B"}</style><img src=x onerror=alert(1)>', color: 'red;background:url(x)', colorLight: 'x' });
await until('a hostile name is only text, and a bad colour is not used', () => {
	const label = rootA.querySelector('.peerkit-yname');
	return label?.textContent.startsWith('B"}</style>') && !rootA.querySelector('img') && ![...document.querySelectorAll('style')].some(s => s.textContent.includes('url(x)'));
});
awarenessB.setLocalStateField('cursor', { anchor: { item: { client: 'x', clock: -1 } }, head: 'nonsense' });
await until('a forged cursor draws nothing and breaks nothing', () => !rootA.querySelector('.peerkit-yname') && !remoteSelection());
awarenessB.setLocalStateField('user', { name: 'B', color: '#0c8599', colorLight: '#0c859933' });
awarenessB.setLocalStateField('cursor', { anchor: Y.createRelativePositionFromTypeIndex(ytextB, 2), head: Y.createRelativePositionFromTypeIndex(ytextB, 2) });
await until('a plain cursor from B shows again', () => rootA.querySelector('.peerkit-yname')?.textContent === 'B');

// Document options apply to Monaco.
byLabel(rootA, 'Document options').click();
let sheet = lastDialog();
const select = sheet.querySelector('select');
select.value = 'python';
select.dispatchEvent(new window.Event('change', { bubbles: true }));
buttonByText(sheet, 'Large').click();
const wrap = sheet.querySelector('input[type=checkbox]');
wrap.checked = false;
wrap.dispatchEvent(new window.Event('change', { bubbles: true }));
buttonByText(sheet, 'Done').click();
await until('the language changes Monaco\'s highlighting and indent', () => modelA().getLanguageId() === 'python' && modelA().getOptions().tabSize === 4);
const { EditorOption } = monaco.editor;
check('the text size and wrapping apply', editorA().getOption(EditorOption.fontSize) === 18 && editorA().getOption(EditorOption.wordWrap) === 'off');

// Switching the editor in Settings moves the open document over, where it was.
const beforeKey = textA();
editorA().focus();
editorA().setPosition(modelA().getPositionAt(beforeKey.length));
type('!');
await until('typed on A', () => textB() === `${beforeKey}!`);
editorA().setSelection(new monaco.Selection(1, 3, 1, 3));
const beforeSwitch = textA();
editorPrefs.setEngine('codemirror');
await until('choosing CodeMirror in Settings shows the document there', () => rootA.querySelector('.cm-editor') && !rootA.querySelector('.monaco-editor'), 10000);
const cmA = () => cm.EditorView.findFromDOM(rootA.querySelector('.cm-editor'));
check('with the same text and cursor', cmA().state.doc.toString() === beforeSwitch && cmA().state.selection.main.head === 2);
check('and Monaco left nothing behind', monaco.editor.getEditors().length === 0 && monaco.editor.getModels().length === 0 && !document.querySelector('.peerkit-yname'));
viewB.view.dispatch({ changes: { from: 0, insert: '>' } });
await until('edits keep flowing after the switch', () => cmA().state.doc.toString() === `>${beforeSwitch}`);
editorPrefs.setEngine('auto');
await sleep(100);
check('Automatic is CodeMirror without a mouse (jsdom matches no pointer)', rootA.querySelector('.cm-editor') && editorPrefs.resolved === 'codemirror');
editorPrefs.setEngine('monaco');
await until('and back to Monaco', () => rootA.querySelector('.monaco-editor') && textA() === `>${beforeSwitch}`);
check('only one Monaco stylesheet after coming back', document.querySelectorAll('link[href$="vendor/monaco.css"]').length === 1);
// Ctrl+Z is the Y.UndoManager's, which outlives the view: this Monaco model is new and has no undo history of its own.
// Monaco takes the platform from Node's process here: Cmd on a Mac, Ctrl elsewhere.
editorA().focus();
const mod = process.platform === 'darwin' ? { metaKey: true } : { ctrlKey: true };
document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', keyCode: 90, ...mod, bubbles: true }));
await until('Ctrl+Z in Monaco undoes what A typed before the switch, and keeps what B typed after it', () => textA() === `>${beforeKey}` && textB() === textA());

// Offline edits on both sides merge.
sA.setUp(false);
sB.setUp(false);
editorA().setPosition({ lineNumber: 1, column: 1 });
editorA().focus();
type('off-A ');
viewB.view.dispatch({ changes: { from: viewB.view.state.doc.length, insert: ' off-B' } });
await sleep(50);
check('offline edits stay apart', textA() !== textB());
sA.setUp(true);
sB.setUp(true);
await until('and merge on reconnect', () => textA() === textB() && textA().startsWith('off-A ') && textA().endsWith(' off-B'));

check('Monaco started its editor worker from vendor/monaco.worker.js', workers.some(url => url.endsWith('/vendor/monaco.worker.js')), workers.join(', '));
unmountA();
check('unmounting disposes Monaco', monaco.editor.getEditors().length === 0 && monaco.editor.getModels().length === 0);
viewB.destroy();
providerB.destroy();
await sleep(50);
check('no errors logged', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
