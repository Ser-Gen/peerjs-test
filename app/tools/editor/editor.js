import { cleanName, device } from '../../device.js';
import { CH } from '../../protocol.js';
import { button, h, icon, openDialog, toast } from '../../ui/dom.js';
import { copyText, formatBytes, indexedDBUsable, randomId, readJSON, sleep, writeJSON } from '../../util.js';
import { LANGS, codeTheme, darkScheme, highlighting, langOf, languageSupport } from '../../ui/code.js';
import { DocProvider } from '../../docsync.js';

const PREFS_KEY = 'peerkit.editor';
const PREFS_VERSION = 1;
const MAX_LAST = 20; // rooms whose last open document is remembered
const STORAGE_WAIT = 4000; // blocked IndexedDB never answers; sync with the others anyway
const SYNC_WAIT = 5000; // a member whose editor doesn't answer doesn't hold up the empty state
const MAX_QUEUED = 5000; // messages kept while the editor bundle loads
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_NAME = 80;
const FONT_SIZES = { small: 13, medium: 15, large: 18 };
const SIZE_LABELS = { small: 'Small', medium: 'Medium', large: 'Large' };
const FALLBACK_COLOR = '#0c8599';
const COLOR_RE = /^#[0-9a-f]{6}$/i;

/*
 * Data (one Y.Doc per room, synced by app/docsync.js and kept in IndexedDB as `peerkit.doc:<room ID>`):
 *   map 'docs': id → Y.Map { name: string, lang: key of LANGS, created: ms, text: Y.Text }
 * Deleting a document deletes its Y.Map, so a rename racing a delete can't bring it back half-empty.
 * Awareness state: { user: {name, color, colorLight}, doc: open document id | null, cursor } (cursor: y-codemirror.next).
 */

export default {
	id: 'editor',
	title: 'Editor',
	supported: () => true,
	mount(el, room, ctx) {
		const tool = new EditorTool(el, room, ctx);
		return () => tool.destroy();
	},
};

const coarse = () => matchMedia('(pointer: coarse)').matches;

const cleanDocName = value => String(value ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);

function fileName({ name, lang }) {
	const base = name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'document';
	return /\.[a-z0-9]{1,8}$/i.test(base) ? base : `${base}.${LANGS[lang].ext}`;
}

function loadPrefs() {
	const raw = readJSON(PREFS_KEY);
	const ok = raw?.version === PREFS_VERSION;
	return {
		wrap: ok ? raw.wrap !== false : true,
		font: ok && Object.hasOwn(FONT_SIZES, raw.font) ? raw.font : 'medium',
		last: ok && raw.last && typeof raw.last === 'object' && !Array.isArray(raw.last) ? raw.last : {},
	};
}

function iconButton(name, label, onclick, className = 'icon-btn') {
	return h('button', { type: 'button', class: className, title: label, 'aria-label': label, onclick }, icon(name));
}

/** A toolbar key that leaves focus (and the on-screen keyboard) in the editor. */
function keyButton(name, label, onclick) {
	const keep = e => e.preventDefault();
	return h('button', { type: 'button', class: 'icon-btn', title: label, 'aria-label': label, onpointerdown: keep, onmousedown: keep, onclick }, icon(name));
}

function presenceChip({ name, color }, title) {
	return h('span', { class: 'presence-chip', style: `--who: ${color}`, title }, name);
}

class EditorTool {
	constructor(root, room, ctx) {
		this.room = room;
		this.ctx = ctx;
		this.prefs = loadPrefs();
		this.lib = null;
		this.loading = null;
		this.loadError = null;
		this.destroyed = false;
		this.queued = []; // doc messages that arrived before the bundle
		this.doc = this.docs = this.awareness = this.persistence = this.provider = null;
		this.view = null;
		this.current = null; // { id, name, lang, entry, text } of the open document
		this.compartments = null;
		this.undoManagers = new Map(); // per document, so undo history survives switching
		this.selections = new Map(); // per document, to come back to the same place
		this.sheet = null; // { dialog, render } of the open documents list
		this.presenceSignature = null;
		this.syncWaited = false;
		this.syncTimer = null;
		this.focused = false;

		this.fileInput = h('input', {
			type: 'file',
			hidden: true,
			onchange: () => {
				const [file] = this.fileInput.files;
				this.fileInput.value = '';
				if (file) this.openFile(file);
			},
		});
		this.docButton = h('button', { type: 'button', class: 'doc-switch', 'aria-label': 'Documents', onclick: () => this.showDocuments() });
		this.presence = h('span', { class: 'presence', hidden: true });
		this.searchBtn = iconButton('search', 'Search', () => this.toggleSearch(), 'icon-btn push');
		this.moreBtn = iconButton('more', 'Document options', () => this.showOptions());
		this.host = h('div', { class: 'editor-host', hidden: true });
		this.message = h('div', { class: 'editor-message' });
		this.keys = h('div', { class: 'editor-keys', role: 'toolbar', 'aria-label': 'Editing keys' },
			keyButton('undo', 'Undo', () => this.undoManager()?.undo()),
			keyButton('redo', 'Redo', () => this.undoManager()?.redo()),
			keyButton('outdent', 'Outdent', () => this.view && this.lib.indentLess(this.view)),
			keyButton('indent', 'Indent', () => this.view && this.lib.indentMore(this.view)),
			keyButton('search', 'Search', () => this.toggleSearch()),
			h('button', { type: 'button', class: 'btn small ghost', onpointerdown: e => e.preventDefault(), onclick: () => this.view?.contentDOM.blur() }, 'Done'));
		this.el = h('div', { class: 'editor' },
			this.fileInput,
			h('div', { class: 'editor-bar' }, this.docButton, this.presence, this.searchBtn, this.moreBtn),
			h('div', { class: 'editor-body' }, this.host, this.message),
			this.keys);
		root.append(this.el);

		// Focus inside the editor, its search panel included, shows the keyboard toolbar on phones.
		this.host.addEventListener('focusin', () => this.setFocused(true));
		this.host.addEventListener('focusout', e => {
			if (!this.host.contains(e.relatedTarget)) this.setFocused(false);
		});
		this.darkQuery = matchMedia('(prefers-color-scheme: dark)');
		this.onScheme = () => this.view?.dispatch({ effects: this.compartments.theme.reconfigure(highlighting(this.lib, darkScheme())) });
		this.darkQuery.addEventListener('change', this.onScheme);

		this.unsubscribe = [
			// Load when another member starts syncing too, so its edits are kept here even if this tab stays closed.
			room.on(`msg:${CH.DOC}`, (msg, member) => this.onEarlyMessage(msg, member)),
			ctx.onShow(() => this.load()),
			room.on('members', () => this.render()),
			// "Open as shared document" from the chat's file viewer.
			ctx.onHandOff?.(file => this.load().then(() => this.openFile(file))) ?? (() => {}),
		];
		if (ctx.visible()) this.load();
		this.render();
	}

	destroy() {
		this.destroyed = true;
		clearTimeout(this.syncTimer);
		this.unsubscribe.forEach(fn => fn());
		this.darkQuery.removeEventListener('change', this.onScheme);
		this.sheet?.dialog.close();
		this.closeView();
		this.provider?.destroy();
		this.awareness?.destroy();
		for (const undoManager of this.undoManagers.values()) undoManager.destroy();
		this.persistence?.destroy();
		this.doc?.destroy();
		this.el.remove();
	}

	// --- loading ---

	onEarlyMessage(msg, member) {
		if (this.provider) return; // the provider has its own subscription
		if (this.queued.length < MAX_QUEUED) this.queued.push([msg, member]);
		this.load();
	}

	load() {
		this.loading ??= this.open().catch(err => {
			console.warn('[peerkit] editor failed to load', err);
			this.loadError = err;
			this.loading = null;
			this.queued = [];
			this.render();
		});
		return this.loading;
	}

	async open() {
		this.loadError = null;
		this.render();
		const lib = await import('../../../vendor/editor.js');
		if (this.destroyed) return;
		const doc = new lib.Y.Doc();
		let persistence = null;
		if (await indexedDBUsable(STORAGE_WAIT)) {
			persistence = new lib.IndexeddbPersistence(`peerkit.doc:${this.ctx.room}`, doc);
			await Promise.race([persistence.whenSynced, sleep(STORAGE_WAIT)]);
		} else {
			console.warn('[peerkit] IndexedDB is not available: documents are not saved on this device');
		}
		if (this.destroyed) {
			persistence?.destroy();
			doc.destroy();
			return;
		}
		this.lib = lib;
		this.doc = doc;
		this.persistence = persistence;
		this.docs = doc.getMap('docs');
		this.awareness = new lib.awarenessProtocol.Awareness(doc);
		this.awareness.setLocalState({ user: this.user(), doc: null });
		this.docs.observeDeep((events, transaction) => this.onDocsChange(events, transaction));
		this.awareness.on('change', () => this.renderPresence());
		const provider = new DocProvider({ lib, room: this.room, doc, awareness: this.awareness });
		doc.on('update', (update, origin) => {
			if (origin?.provider === provider) this.ctx.notify();
		});
		provider.on('synced', () => {
			if (!this.current) this.openInitial();
			this.render();
		});
		this.provider = provider;
		this.syncTimer = setTimeout(() => {
			this.syncWaited = true;
			this.render();
		}, SYNC_WAIT);
		for (const [msg, member] of this.queued.splice(0)) provider.receive(msg, member);
		this.openInitial();
	}

	user() {
		const { color } = this.room.self;
		return { name: device.name, color, colorLight: `${color}33` };
	}

	// --- documents ---

	readEntry(id) {
		const { Y } = this.lib;
		const entry = this.docs.get(id);
		const text = entry instanceof Y.Map ? entry.get('text') : null;
		if (!(text instanceof Y.Text)) return null;
		const lang = entry.get('lang');
		return {
			id,
			entry,
			text,
			name: cleanDocName(entry.get('name')) || 'Untitled',
			lang: Object.hasOwn(LANGS, lang) ? lang : 'text',
		};
	}

	list() {
		if (!this.docs) return [];
		return [...this.docs.keys()]
			.map(id => this.readEntry(id))
			.filter(Boolean)
			.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
	}

	/** The remembered document for this room, or the first one. */
	openInitial() {
		const list = this.list();
		const target = list.find(item => item.id === this.prefs.last[this.ctx.room]) ?? list[0];
		if (target) this.openDoc(target.id);
		else this.render();
	}

	onDocsChange(events, transaction) {
		// Typing changes a Y.Text; only names, languages and the list itself matter here.
		if (events.every(event => event.target instanceof this.lib.Y.Text)) return;
		const current = this.current;
		if (current) {
			const fresh = this.readEntry(current.id);
			if (!fresh) {
				this.closeView();
				this.forget(current.id);
				const from = transaction.origin?.provider === this.provider ? this.room.member(transaction.origin.peerId) : null;
				if (transaction.origin?.provider === this.provider) toast(`${from?.name ?? 'Someone'} deleted “${current.name}”`);
				this.openInitial();
			} else {
				if (fresh.lang !== current.lang) this.view.dispatch({ effects: this.compartments.lang.reconfigure(this.languageExtensions(fresh.lang)) });
				this.current = fresh;
			}
		} else {
			this.openInitial(); // e.g. another member created the first document
		}
		this.render();
		this.sheet?.render();
	}

	createDoc({ name = '', lang = 'text', content = '' } = {}) {
		const { Y } = this.lib;
		const id = randomId(8);
		this.rememberLast(id); // the change observer opens it
		this.doc.transact(() => {
			const entry = new Y.Map();
			this.docs.set(id, entry);
			entry.set('name', cleanDocName(name) || this.untitledName());
			entry.set('lang', lang);
			entry.set('created', Date.now());
			const text = new Y.Text();
			entry.set('text', text);
			if (content) text.insert(0, content);
		});
		this.openDoc(id);
		if (!coarse()) this.view?.focus();
	}

	untitledName() {
		const names = new Set(this.list().map(item => item.name));
		let name = 'Untitled';
		for (let n = 2; names.has(name); n++) name = `Untitled ${n}`;
		return name;
	}

	async openFile(file) {
		if (!this.provider) return;
		if (file.size > MAX_FILE_BYTES) {
			toast(`The file is too large for the editor (over ${formatBytes(MAX_FILE_BYTES)})`);
			return;
		}
		let content;
		try {
			content = await file.text();
		} catch {
			toast('Could not read the file');
			return;
		}
		if (content.includes('\0')) {
			toast('This is not a text file');
			return;
		}
		// CodeMirror counts a line break as one character; a CRLF in the Y.Text would shift every position after it.
		this.createDoc({ name: file.name, lang: langOf(file.name), content: content.replace(/\r\n?/g, '\n') });
	}

	rename(id, value) {
		const name = cleanDocName(value);
		const entry = this.readEntry(id)?.entry;
		if (name && entry && entry.get('name') !== name) entry.set('name', name);
	}

	setLang(id, lang) {
		const entry = this.readEntry(id)?.entry;
		if (entry && Object.hasOwn(LANGS, lang)) entry.set('lang', lang);
	}

	deleteDoc(item) {
		if (!confirm(`Delete “${item.name}”?\n\nIt is deleted for everyone in the room.`)) return false;
		if (this.current?.id === item.id) this.closeView();
		this.forget(item.id);
		this.docs.delete(item.id);
		return true;
	}

	forget(id) {
		this.undoManagers.get(id)?.destroy();
		this.undoManagers.delete(id);
		this.selections.delete(id);
	}

	// --- the editor view ---

	openDoc(id) {
		if (this.current?.id === id && this.view) return;
		const item = this.readEntry(id);
		if (!item) return;
		this.closeView();
		const { lib } = this;
		let undoManager = this.undoManagers.get(id);
		if (!undoManager) this.undoManagers.set(id, (undoManager = new lib.Y.UndoManager(item.text)));
		this.compartments = { theme: new lib.Compartment(), wrap: new lib.Compartment(), lang: new lib.Compartment() };
		const saved = this.selections.get(id);
		const length = item.text.length;
		const selection = saved ? lib.EditorSelection.single(Math.min(saved.anchor, length), Math.min(saved.head, length)) : undefined;
		this.view = new lib.EditorView({
			parent: this.host,
			state: lib.EditorState.create({ doc: item.text.toString(), selection, extensions: this.extensions(item, undoManager) }),
		});
		if (selection) this.view.dispatch({ effects: lib.EditorView.scrollIntoView(selection.main.head, { y: 'center' }) });
		this.current = item;
		this.awareness.setLocalStateField('doc', id);
		this.rememberLast(id);
		this.render();
	}

	closeView() {
		if (!this.view) return;
		const { anchor, head } = this.view.state.selection.main;
		this.selections.set(this.current.id, { anchor, head });
		this.view.destroy();
		this.view = null;
		this.current = null;
		this.setFocused(false);
		const state = this.awareness.getLocalState();
		if (state) this.awareness.setLocalState({ ...state, cursor: null, doc: null });
	}

	extensions(item, undoManager) {
		const { lib, compartments } = this;
		return [
			lib.lineNumbers(),
			lib.highlightActiveLineGutter(),
			lib.highlightSpecialChars(),
			lib.foldGutter(),
			lib.drawSelection(),
			lib.dropCursor(),
			lib.EditorState.allowMultipleSelections.of(true),
			lib.indentOnInput(),
			lib.bracketMatching(),
			lib.closeBrackets(),
			lib.rectangularSelection(),
			lib.crosshairCursor(),
			lib.highlightActiveLine(),
			lib.highlightSelectionMatches(),
			lib.search({ top: true }), // away from the on-screen keyboard
			compartments.theme.of(highlighting(lib, darkScheme())),
			compartments.wrap.of(this.prefs.wrap ? lib.EditorView.lineWrapping : []),
			compartments.lang.of(this.languageExtensions(item.lang)),
			// Collaborative undo instead of CodeMirror's history, which would also undo the others' edits.
			lib.Prec.high(lib.keymap.of([...lib.yUndoManagerKeymap, ...lib.closeBracketsKeymap])),
			lib.keymap.of([...lib.vscodeKeymap, lib.indentWithTab]),
			lib.yCollab(item.text, this.awareness, { undoManager }),
			codeTheme(lib),
		];
	}

	languageExtensions(lang) {
		// Autocorrect and swipe typing help prose; in code they mangle identifiers.
		const attrs = LANGS[lang].prose
			? { spellcheck: 'true', autocorrect: 'on', autocapitalize: 'sentences', writingsuggestions: 'true' }
			: { spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' };
		return [languageSupport(this.lib, lang), this.lib.EditorView.contentAttributes.of(attrs)];
	}

	undoManager() {
		return this.current ? this.undoManagers.get(this.current.id) : null;
	}

	toggleSearch() {
		const { view, lib } = this;
		if (!view) return;
		if (lib.searchPanelOpen(view.state)) {
			lib.closeSearchPanel(view);
			if (coarse()) view.contentDOM.blur();
		} else {
			lib.openSearchPanel(view);
		}
	}

	setFocused(focused) {
		if (this.focused === focused) return;
		this.focused = focused;
		this.el.toggleAttribute('data-focused', focused);
	}

	// --- preferences ---

	savePrefs(patch) {
		this.prefs = { ...this.prefs, ...patch };
		writeJSON(PREFS_KEY, { version: PREFS_VERSION, ...this.prefs });
	}

	rememberLast(id) {
		const room = this.ctx.room;
		if (this.prefs.last[room] === id) return;
		const last = { ...this.prefs.last };
		delete last[room]; // re-insert, so the oldest rooms are first to go
		last[room] = id;
		const rooms = Object.keys(last);
		for (const old of rooms.slice(0, Math.max(0, rooms.length - MAX_LAST))) delete last[old];
		this.savePrefs({ last });
	}

	setWrap(wrap) {
		this.savePrefs({ wrap });
		this.view?.dispatch({ effects: this.compartments.wrap.reconfigure(wrap ? this.lib.EditorView.lineWrapping : []) });
	}

	setFont(font) {
		this.savePrefs({ font });
		this.render();
		this.view?.requestMeasure();
	}

	// --- actions ---

	async copyAll(item) {
		toast((await copyText(item.text.toString())) ? 'Copied' : 'Copy failed');
	}

	download(item) {
		const url = URL.createObjectURL(new Blob([item.text.toString()], { type: 'text/plain;charset=utf-8' }));
		const link = h('a', { href: url, download: fileName(item), hidden: true });
		document.body.append(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 60000);
	}

	async share(item) {
		const text = item.text.toString();
		const file = new File([text], fileName(item), { type: 'text/plain' });
		try {
			if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: item.name });
			else await navigator.share({ title: item.name, text });
		} catch (err) {
			if (err?.name !== 'AbortError') toast('Sharing failed');
		}
	}

	// --- rendering ---

	render() {
		const ready = Boolean(this.provider);
		this.el.style.setProperty('--editor-font-size', `${FONT_SIZES[this.prefs.font]}px`);
		this.host.hidden = !this.view;
		this.keys.hidden = !this.view;
		this.searchBtn.disabled = this.moreBtn.disabled = !this.view;
		this.docButton.disabled = !ready;
		this.docButton.replaceChildren(icon('file'), h('span', { class: 'doc-name' }, this.current?.name ?? 'Documents'), icon('chevron-down'));
		this.renderPresence();
		this.renderMessage();
	}

	renderMessage() {
		let content = null;
		const spinner = () => h('div', { class: 'spinner', 'aria-hidden': 'true' });
		if (this.loadError) {
			content = [
				h('p', {}, 'Could not load the editor.'),
				h('p', { class: 'hint' }, 'Check the internet connection and try again.'),
				button('Try again', null, () => this.load(), 'btn primary'),
			];
		} else if (!this.provider) {
			content = [spinner(), h('p', {}, 'Loading the editor…')];
		} else if (!this.view && this.room.members.length && !this.provider.synced && !this.syncWaited) {
			content = [spinner(), h('p', {}, 'Syncing with the room…')];
		} else if (!this.view) {
			content = [
				icon('edit'),
				h('p', {}, 'Write together with everyone in the room.'),
				h('p', { class: 'hint' }, this.persistence
					? 'Documents are kept on every device in the room. Edits made while apart merge when you meet again.'
					: 'This browser doesn’t let PeerKit save documents, so here they last only while the page is open.'),
				h('div', { class: 'actions' },
					button('New document', 'plus', () => this.createDoc(), 'btn primary'),
					button('Open file', 'upload', () => this.fileInput.click(), 'btn')),
			];
		}
		this.message.hidden = !content;
		if (content) this.message.replaceChildren(...content);
	}

	remoteStates() {
		if (!this.awareness) return [];
		const own = this.doc.clientID;
		return [...this.awareness.getStates()]
			.filter(([id]) => id !== own)
			.map(([, state]) => ({
				name: cleanName(state?.user?.name) || 'Device',
				color: COLOR_RE.test(state?.user?.color) ? state.user.color : FALLBACK_COLOR,
				doc: typeof state?.doc === 'string' ? state.doc : null,
			}));
	}

	/** Who has which document open. Cursor moves fire awareness changes too, so re-render only on a real difference. */
	renderPresence() {
		const states = this.remoteStates();
		const signature = JSON.stringify([this.current?.id, states]);
		if (signature === this.presenceSignature) return;
		this.presenceSignature = signature;
		const here = states.filter(state => state.doc && state.doc === this.current?.id);
		this.presence.hidden = !here.length;
		this.presence.replaceChildren(...here.map(state => presenceChip(state, `${state.name} has this document open`)));
		this.sheet?.render();
	}

	showDocuments() {
		if (!this.provider) return;
		this.sheet?.dialog.close();
		const list = h('ul', { class: 'doc-list' });
		const render = () => {
			const items = this.list();
			const states = this.remoteStates();
			list.replaceChildren(...items.map(item => h('li', {},
				h('button', {
					type: 'button',
					class: 'doc-item',
					'aria-current': String(item.id === this.current?.id),
					onclick: () => {
						dialog.close();
						this.openDoc(item.id);
						if (!coarse()) this.view?.focus();
					},
				},
				h('span', { class: 'doc-item-name' }, item.name),
				h('span', { class: 'doc-item-meta' },
					`${LANGS[item.lang].label} · ${formatBytes(item.text.length)}`,
					...states.filter(state => state.doc === item.id).map(state => presenceChip(state, `${state.name} has it open`)))))));
			if (!items.length) list.append(h('li', { class: 'hint' }, 'No documents yet.'));
		};
		const dialog = openDialog(h('div', { class: 'sheet-body' },
			h('h2', {}, 'Documents'),
			list,
			h('div', { class: 'actions end' },
				button('Open file', 'upload', () => {
					dialog.close();
					this.fileInput.click();
				}, 'btn'),
				button('New document', 'plus', () => {
					dialog.close();
					this.createDoc();
				}, 'btn primary'))));
		const sheet = (this.sheet = { dialog, render });
		dialog.addEventListener('close', () => {
			if (this.sheet === sheet) this.sheet = null;
		});
		render();
	}

	showOptions() {
		const item = this.current;
		if (!item) return;
		// The name and language may change while the sheet is open, here or on another device.
		const latest = () => this.readEntry(item.id) ?? item;
		const name = h('input', {
			class: 'input',
			value: item.name,
			maxlength: MAX_NAME,
			enterkeyhint: 'done',
			autocomplete: 'off',
			onkeydown: e => {
				if (e.key === 'Enter') {
					e.preventDefault();
					name.blur();
				}
			},
			onchange: () => this.rename(item.id, name.value),
		});
		const lang = h('select', { class: 'input', onchange: () => this.setLang(item.id, lang.value) },
			Object.entries(LANGS).map(([id, { label }]) => h('option', { value: id, selected: id === item.lang }, label)));
		const sizes = Object.keys(FONT_SIZES).map(size => h('button', {
			type: 'button',
			class: 'segment',
			'aria-pressed': String(size === this.prefs.font),
			onclick: () => {
				this.setFont(size);
				sizes.forEach(el => el.setAttribute('aria-pressed', String(el === sizeButton(size))));
			},
		}, SIZE_LABELS[size]));
		const sizeButton = size => sizes[Object.keys(FONT_SIZES).indexOf(size)];
		const wrap = h('input', { type: 'checkbox', checked: this.prefs.wrap, onchange: () => this.setWrap(wrap.checked) });
		const dialog = openDialog(h('div', { class: 'sheet-body' },
			h('h2', {}, 'Document'),
			h('label', { class: 'field' }, h('span', {}, 'Name'), name),
			h('label', { class: 'field' }, h('span', {}, 'Language'), lang),
			h('div', { class: 'field' }, h('span', {}, 'Text size'), h('div', { class: 'segmented' }, sizes)),
			h('label', { class: 'check' }, wrap, h('span', {}, 'Wrap long lines')),
			h('p', { class: 'hint' }, 'Name and language change for everyone. Text size and wrapping are for this device.'),
			h('div', { class: 'actions start' },
				button('Copy all', 'copy', () => this.copyAll(latest())),
				button('Download', 'download', () => this.download(latest())),
				navigator.share && button('Share', 'share', () => this.share(latest())),
				button('Delete', 'trash', () => {
					if (this.deleteDoc(latest())) dialog.close();
				}, 'btn small danger')),
			h('div', { class: 'actions end' }, button('Done', null, () => dialog.close(), 'btn primary'))));
		// Esc or the back gesture closes the sheet without a change event.
		dialog.addEventListener('close', () => this.rename(item.id, name.value));
	}
}
