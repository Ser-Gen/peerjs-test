import { cleanName } from '../../device.js';
import { CH } from '../../protocol.js';
import { RoomDoc, boardDocName } from '../../roomdoc.js';
import { button, h, icon, openDialog, toast } from '../../ui/dom.js';
import { readJSON, writeJSON } from '../../util.js';
import { download } from '../chat/viewer.js';
import { Boards, MAX_IMAGES, MAX_NAME } from './boards.js';
import { BoardView, PAPER, drawItem } from './canvas.js';
import { canReadClipboard, clipboardImages, decodeImage, imageFiles, prepareImage } from './images.js';
import { MAX_POINTS, itemBounds, unionBounds } from './ink.js';

const PREFS_KEY = 'peerkit.whiteboard';
const PREFS_VERSION = 1;
const MAX_LAST = 20; // rooms whose last open board is remembered
const SYNC_WAIT = 5000; // a member whose whiteboard doesn't answer doesn't hold up the empty state
const EXPORT_SCALE = 2; // a PNG has two pixels per board unit, so it stays sharp on a phone
const EXPORT_MAX = 4096; // px, its long side at most
const EXPORT_MARGIN = 24;
const COLORS = ['#1e1e1e', '#e03131', '#f08c00', '#fcc419', '#2f9e44', '#1971c2', '#9c36b5', '#ffffff'];
const COLOR_NAMES = ['Black', 'Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple', 'White'];
const SIZES = { pen: [2, 4, 8], highlighter: [12, 20, 32] };
const SIZE_NAMES = ['Thin', 'Medium', 'Thick'];
const DEFAULT_STYLE = { pen: { color: COLORS[0], size: 4 }, highlighter: { color: COLORS[3], size: 20 } };
const TOOLS = {
	select: ['Select and move (V)', 'pointer'],
	pen: ['Pen (P)', 'pencil'],
	highlighter: ['Highlighter (H)', 'highlighter'],
	eraser: ['Eraser (E)', 'eraser'],
};
const KEYS = { v: 'select', p: 'pen', h: 'highlighter', e: 'eraser' };
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const FALLBACK_COLOR = '#0c8599';
const MAX_LIVE_SIZE = 200;

/*
 * The shared whiteboard. Boards live in a Y.Doc of their own (boards.js, kept and synced by app/roomdoc.js on
 * ch 'board'), so they are on every device in the room, a newcomer gets them, and drawings made while apart merge.
 * A finished stroke is simplified and stored; while it is drawn the others see it through awareness:
 *   { user: {name, color}, board: open board id | null, pointer: [x, y] | null, stroke: {kind, color, size, points} | null }
 * Undo takes back only this device's own changes (Y.UndoManager on the local origin). Images come from the
 * clipboard (Ctrl+V, or the Paste button through the Clipboard API), a file or a drop, and are stored in the
 * board document itself, made small first (images.js).
 */

export default {
	id: 'whiteboard',
	title: 'Whiteboard',
	supported: () => true,
	mount(el, room, ctx) {
		const tool = new WhiteboardTool(el, room, ctx);
		return () => tool.destroy();
	},
};

const coarse = () => matchMedia('(pointer: coarse)').matches;

function loadPrefs() {
	const raw = readJSON(PREFS_KEY);
	const ok = raw?.version === PREFS_VERSION;
	const style = kind => {
		const saved = ok ? raw[kind] : null;
		return {
			color: COLOR_RE.test(saved?.color) ? saved.color : DEFAULT_STYLE[kind].color,
			size: SIZES[kind].includes(saved?.size) ? saved.size : DEFAULT_STYLE[kind].size,
		};
	};
	return {
		tool: ok && Object.hasOwn(TOOLS, raw.tool) ? raw.tool : 'pen',
		pen: style('pen'),
		highlighter: style('highlighter'),
		last: ok && raw.last && typeof raw.last === 'object' && !Array.isArray(raw.last) ? raw.last : {},
	};
}

const liveStrokes = new WeakMap(); // each awareness update brings new objects, so each is checked once

/** A stroke in progress from a member's awareness state, or null when it isn't a valid one. */
function readLiveStroke(stroke) {
	if (!stroke || typeof stroke !== 'object') return null;
	if (liveStrokes.has(stroke)) return liveStrokes.get(stroke);
	const { kind, color, size, points } = stroke;
	const ok = (kind === 'pen' || kind === 'highlighter') && COLOR_RE.test(color)
		&& typeof size === 'number' && size >= 0.5 && size <= MAX_LIVE_SIZE
		&& Array.isArray(points) && points.length > 0 && points.length % 3 === 0 && points.length <= MAX_POINTS * 3
		&& points.every((value, i) => typeof value === 'number' && Number.isFinite(value) && (i % 3 !== 2 || (value >= 0 && value <= 1)));
	const result = ok ? { kind, color, size, points } : null;
	liveStrokes.set(stroke, result);
	return result;
}

const readPointer = pointer => (Array.isArray(pointer) && pointer.length === 2 && pointer.every(Number.isFinite) ? pointer : null);

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function describeCounts({ strokes, images }) {
	if (!strokes && !images) return 'Empty';
	return [strokes && plural(strokes, 'stroke'), images && plural(images, 'image')].filter(Boolean).join(', ');
}

const fileBase = name => name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'board';

function iconButton(name, label, onclick, className = 'icon-btn') {
	return h('button', { type: 'button', class: className, title: label, 'aria-label': label, onclick }, icon(name));
}

function presenceChip({ name, color }, title) {
	return h('span', { class: 'presence-chip', style: `--who: ${color}`, title }, name);
}

class WhiteboardTool {
	constructor(root, room, ctx) {
		this.room = room;
		this.ctx = ctx;
		this.prefs = loadPrefs();
		this.data = new RoomDoc(room, ctx.room, { name: boardDocName(ctx.room), channel: CH.BOARD, awareness: true, loadOnMessage: true, about: 'the whiteboard' });
		this.boards = null;
		this.current = null; // id of the open board
		this.currentName = '';
		this.cameras = new Map(); // board id → where the view was, to come back to the same place
		this.loadError = null;
		this.syncWaited = false;
		this.syncTimer = null;
		this.destroyed = false;
		this.sheet = null; // { dialog, render } of the open boards list
		this.menu = null; // 'style' or 'image' while its popover is open
		this.presenceSignature = null;

		this.view = new BoardView({
			items: () => (this.current ? this.boards.items(this.current) : []),
			remote: () => this.remoteStates().filter(state => state.board === this.current),
			visible: () => Boolean(this.current) && this.ctx.visible(),
			onStroke: stroke => this.boards.addStroke(this.current, stroke),
			onErase: maps => this.boards.erase(this.current, maps),
			onMove: (map, x, y) => this.boards.move(this.current, map, x, y),
			onResize: (map, box) => this.boards.resize(this.current, map, box),
			onSelect: () => this.renderTools(),
			onLive: state => this.setLocal(state),
			blocked: () => this.closeMenu(), // a tap on the board while a popover is open only closes it
		});

		this.fileInput = h('input', {
			type: 'file',
			accept: 'image/*',
			multiple: true,
			hidden: true,
			onchange: () => {
				const files = [...this.fileInput.files];
				this.fileInput.value = '';
				this.insertImages(files);
			},
		});
		this.boardButton = h('button', { type: 'button', class: 'doc-switch', 'aria-label': 'Boards', onclick: () => this.showBoards() });
		this.presence = h('span', { class: 'presence', hidden: true });
		this.undoBtn = iconButton('undo', 'Undo (Ctrl+Z)', () => this.undo(), 'icon-btn push');
		this.redoBtn = iconButton('redo', 'Redo (Ctrl+Shift+Z)', () => this.redo());
		this.moreBtn = iconButton('more', 'Board options', () => this.showOptions());
		this.toolButtons = new Map(Object.entries(TOOLS).map(([tool, [label, name]]) => [tool, h('button', {
			type: 'button',
			class: 'icon-btn',
			title: label,
			'aria-label': label,
			onclick: () => this.setTool(tool),
		}, icon(name))]));
		this.swatch = h('span', { class: 'wb-swatch' });
		this.styleBtn = h('button', { type: 'button', class: 'icon-btn', title: 'Colour and size', 'aria-label': 'Colour and size', onclick: () => this.toggleMenu('style') }, this.swatch);
		this.deleteBtn = iconButton('trash', 'Delete the selection (Delete)', () => this.deleteSelection());
		this.imageBtn = iconButton('image', 'Add an image', () => (canReadClipboard() ? this.toggleMenu('image') : this.fileInput.click()), 'icon-btn push');
		this.fitBtn = iconButton('fit', 'Show the whole board', () => this.view.fitContent());
		this.tools = h('div', { class: 'wb-tools', role: 'toolbar', 'aria-label': 'Drawing tools' },
			...this.toolButtons.values(), h('span', { class: 'wb-sep' }), this.styleBtn, this.deleteBtn, this.imageBtn, this.fitBtn);
		this.popover = h('div', { class: 'wb-popover', hidden: true });
		this.message = h('div', { class: 'editor-message' });
		this.el = h('div', { class: 'whiteboard' },
			this.fileInput,
			h('div', { class: 'editor-bar' }, this.boardButton, this.presence, this.undoBtn, this.redoBtn, this.moreBtn),
			h('div', { class: 'wb-body' }, this.view.el, this.popover, this.message),
			this.tools);
		root.append(this.el);

		this.view.el.addEventListener('keydown', e => this.onKey(e));
		this.view.el.addEventListener('keyup', e => {
			if (e.key === ' ') this.view.spaceHeld = false;
		});
		// Images dropped on the board go onto it, not into the chat's send sheet.
		this.el.addEventListener('dragover', e => {
			if (!this.current || !e.dataTransfer?.types?.includes('Files')) return;
			e.preventDefault();
			e.stopPropagation();
		});
		this.el.addEventListener('drop', e => {
			if (!this.current || !e.dataTransfer?.files?.length) return;
			e.preventDefault();
			e.stopPropagation();
			const files = imageFiles(e.dataTransfer);
			if (files.length) this.insertImages(files, this.view.toBoard(e.clientX, e.clientY));
			else toast('Only images can go on the board');
		});
		this.onPaste = e => this.handlePaste(e);
		document.addEventListener('paste', this.onPaste);
		this.onOutside = e => {
			if (this.menu && !this.popover.contains(e.target) && !this.menuButton().contains(e.target) && !this.view.el.contains(e.target)) this.closeMenu();
		};
		document.addEventListener('pointerdown', this.onOutside, true);

		this.unsubscribe = [
			this.data.on('loaded', () => this.ready()),
			this.data.on('synced', () => {
				if (!this.boards) return;
				this.openInitial();
				this.render();
			}),
			ctx.onShow(() => this.onShow()),
			room.on('members', () => this.render()),
		];
		this.setTool(this.prefs.tool, false);
		if (ctx.visible()) this.load();
		this.render();
	}

	destroy() {
		this.destroyed = true;
		clearTimeout(this.syncTimer);
		this.unsubscribe.forEach(fn => fn());
		document.removeEventListener('paste', this.onPaste);
		document.removeEventListener('pointerdown', this.onOutside, true);
		this.sheet?.dialog.close();
		this.view.destroy();
		this.boards?.destroy();
		this.data.destroy();
		this.el.remove();
	}

	// --- loading ---

	load() {
		this.loadError = null;
		this.data.load().catch(err => {
			console.warn('[peerkit] the whiteboard failed to load', err);
			this.loadError = err;
			this.render();
		});
	}

	/** The board document is here (because this tab was opened, or because a member started syncing it). */
	ready() {
		if (this.boards || this.destroyed) return;
		const { lib, doc, awareness } = this.data;
		this.boards = new Boards(lib, doc, this.room.self.deviceId);
		this.boards.on('change', transaction => this.onChange(transaction));
		this.boards.on('undo', id => {
			if (id === this.current) this.renderUndo();
		});
		awareness.setLocalState({ user: { name: this.room.self.name, color: this.room.self.color }, board: null, pointer: null, stroke: null });
		awareness.on('change', () => {
			this.view.requestRender(false);
			this.renderPresence();
		});
		doc.on('update', (update, origin) => {
			if (this.data.isRemote(origin)) this.ctx.notify();
		});
		this.syncTimer = setTimeout(() => {
			this.syncWaited = true;
			this.render();
		}, SYNC_WAIT);
		this.openInitial();
		this.render();
	}

	onShow() {
		this.load();
		this.view.resize();
		this.view.requestRender();
	}

	// --- boards ---

	onChange(transaction) {
		if (this.current && !this.boards.read(this.current)) {
			const name = this.currentName;
			if (this.data.isRemote(transaction.origin)) toast(`${this.data.memberOf(transaction.origin)?.name ?? 'Someone'} deleted “${name}”`);
			this.closeBoard();
			this.openInitial();
		} else if (this.current) {
			this.currentName = this.boards.read(this.current).name;
			this.view.itemsChanged();
		} else {
			this.openInitial(); // e.g. another member made the first board
		}
		this.render();
		this.sheet?.render();
	}

	/** The board last open here in this room, or the first one. */
	openInitial() {
		if (!this.boards || this.current) return;
		const list = this.boards.list();
		const target = list.find(board => board.id === this.prefs.last[this.ctx.room]) ?? list[0];
		if (target) this.openBoard(target.id);
	}

	openBoard(id) {
		if (this.current === id) return;
		const board = this.boards.read(id);
		if (!board) return;
		this.closeBoard();
		this.current = id;
		this.currentName = board.name;
		this.boards.undoManager(id); // from now on, what this device does here can be undone
		this.render(); // the stage is shown, so it has a size
		this.view.open(this.cameras.get(id) ?? null);
		this.setLocal({ board: id, pointer: null, stroke: null });
		this.rememberLast(id);
	}

	closeBoard() {
		if (!this.current) return;
		this.cameras.set(this.current, { ...this.view.camera });
		this.view.close();
		this.current = null;
		this.setLocal({ board: null, pointer: null, stroke: null });
	}

	createBoard() {
		if (!this.boards) return;
		const id = this.boards.create();
		this.rememberLast(id);
		this.closeBoard();
		this.openBoard(id);
		if (!coarse()) this.view.el.focus({ preventScroll: true });
	}

	clearBoard(id) {
		const board = this.boards.read(id);
		if (!board || !confirm(`Clear “${board.name}”?\n\nEverything on it goes, for everyone in the room. Undo brings it back.`)) return false;
		this.boards.clear(id);
		return true;
	}

	deleteBoard(id) {
		const board = this.boards.read(id);
		if (!board || !confirm(`Delete “${board.name}”?\n\nIt is deleted for everyone in the room.`)) return false;
		this.cameras.delete(id);
		this.boards.remove(id);
		return true;
	}

	// --- tools ---

	setTool(tool, save = true) {
		this.view.setTool(tool);
		if (tool === 'pen' || tool === 'highlighter') this.view.style = { ...this.prefs[tool] };
		if (save && tool !== this.prefs.tool) this.savePrefs({ tool });
		if (this.menu === 'style') this.renderMenu(); // it shows the colours of the pen in hand
		this.renderTools();
	}

	/** The pen or the highlighter: the one the colour and size are for. */
	styleKind() {
		return this.view.tool === 'highlighter' ? 'highlighter' : 'pen';
	}

	/** Picking a colour or a size means drawing: it switches to that pen. */
	setStyle(patch) {
		const kind = this.styleKind();
		this.savePrefs({ [kind]: { ...this.prefs[kind], ...patch } });
		this.setTool(kind);
	}

	undo() {
		if (this.current) this.boards.undoManager(this.current)?.undo();
	}

	redo() {
		if (this.current) this.boards.undoManager(this.current)?.redo();
	}

	deleteSelection() {
		const map = this.view.selected;
		if (!map || !this.current) return;
		this.view.select(null);
		this.boards.erase(this.current, [map]);
	}

	onKey(e) {
		const key = e.key.toLowerCase();
		if ((e.ctrlKey || e.metaKey) && !e.altKey) {
			if (key === 'z' || key === 'y') {
				e.preventDefault();
				if (key === 'z' && !e.shiftKey) this.undo();
				else this.redo();
			}
			return;
		}
		if (e.altKey) return;
		if (e.key === ' ') {
			e.preventDefault(); // no page scroll: Space held pans the board
			this.view.spaceHeld = true;
		} else if (e.key === 'Delete' || e.key === 'Backspace') {
			e.preventDefault();
			this.deleteSelection();
		} else if (e.key === 'Escape') {
			this.view.select(null);
		} else if (e.key === '+' || e.key === '=') {
			this.view.zoomBy(1.25);
		} else if (e.key === '-') {
			this.view.zoomBy(0.8);
		} else if (Object.hasOwn(KEYS, key)) {
			this.setTool(KEYS[key]);
		}
	}

	// --- images ---

	/** Ctrl+V: into the board, or with nothing else focused. A paste into a text field stays there. */
	handlePaste(e) {
		if (!this.current || !this.ctx.visible()) return;
		const target = e.target;
		if (!this.el.contains(target) && target !== document.body && target !== document.documentElement) return;
		const files = imageFiles(e.clipboardData);
		if (!files.length) return;
		e.preventDefault();
		this.insertImages(files);
	}

	async pasteFromClipboard() {
		let images;
		try {
			images = await clipboardImages();
		} catch (err) {
			toast(err?.name === 'NotAllowedError' ? 'PeerKit isn’t allowed to read the clipboard' : 'Could not read the clipboard');
			return;
		}
		if (!images.length) toast('There is no image on the clipboard');
		else this.insertImages(images);
	}

	/** Onto the open board, at `at` or in the middle of the view; the new image is selected, ready to move. */
	async insertImages(blobs, at = null) {
		const id = this.current;
		let index = 0;
		for (const blob of blobs) {
			if (!this.boards || this.current !== id) return;
			if (this.boards.counts(id).images >= MAX_IMAGES) {
				toast(`A board holds up to ${MAX_IMAGES} images`);
				return;
			}
			let image;
			try {
				image = await prepareImage(blob);
			} catch (err) {
				toast(err?.code === 'large' ? 'The image is too large for the board' : 'Could not read the image');
				continue;
			}
			if (this.destroyed || this.current !== id) return;
			const map = this.boards.addImage(id, { ...this.view.placeImage(image.width, image.height, at, index++), data: image.data });
			if (!map) return;
			this.setTool('select');
			this.view.select(map);
		}
	}

	// --- export ---

	/** The whole board as a PNG, on paper, two pixels per board unit (less for a very large drawing). */
	async exportFile(id) {
		const board = this.boards?.read(id);
		if (!board) return null;
		const items = this.boards.items(id);
		if (!items.length) {
			toast('The board is empty');
			return null;
		}
		const box = unionBounds(items.map(itemBounds));
		const width = box.maxX - box.minX + EXPORT_MARGIN * 2;
		const height = box.maxY - box.minY + EXPORT_MARGIN * 2;
		const scale = Math.min(EXPORT_SCALE, EXPORT_MAX / Math.max(width, height));
		const bitmaps = new Map();
		await Promise.all(items.filter(item => item.kind === 'image').map(async item => {
			bitmaps.set(item.data, await decodeImage(item.data).catch(() => null));
		}));
		const canvas = h('canvas', { width: Math.ceil(width * scale), height: Math.ceil(height * scale) });
		const ctx = canvas.getContext('2d');
		let blob = null;
		if (ctx) {
			ctx.fillStyle = PAPER;
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			ctx.setTransform(scale, 0, 0, scale, (EXPORT_MARGIN - box.minX) * scale, (EXPORT_MARGIN - box.minY) * scale);
			for (const item of items) drawItem(ctx, item, bitmaps.get(item.data) ?? null);
			blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
		}
		for (const bitmap of bitmaps.values()) bitmap?.close?.();
		if (!blob) {
			toast('Could not make the picture');
			return null;
		}
		return new File([blob], `${fileBase(board.name)}.png`, { type: 'image/png' });
	}

	async sendToChat(id) {
		const file = await this.exportFile(id);
		if (file && !this.ctx.handOff?.('chat', file)) toast('The chat can’t take it right now');
	}

	async downloadPng(id) {
		const file = await this.exportFile(id);
		if (file) download(file, file.name);
	}

	// --- awareness ---

	setLocal(patch) {
		const awareness = this.data.awareness;
		const state = awareness?.getLocalState();
		if (state) awareness.setLocalState({ ...state, ...patch });
	}

	remoteStates() {
		const awareness = this.data.awareness;
		if (!awareness) return [];
		const own = this.data.doc.clientID;
		return [...awareness.getStates()]
			.filter(([id]) => id !== own)
			.map(([, state]) => ({
				name: cleanName(state?.user?.name) || 'Device',
				color: COLOR_RE.test(state?.user?.color) ? state.user.color : FALLBACK_COLOR,
				board: typeof state?.board === 'string' ? state.board : null,
				pointer: readPointer(state?.pointer),
				stroke: readLiveStroke(state?.stroke),
			}));
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

	// --- rendering ---

	render() {
		const open = Boolean(this.current);
		this.boardButton.disabled = !this.boards;
		this.boardButton.replaceChildren(icon('board'), h('span', { class: 'doc-name' }, open ? this.currentName : 'Boards'), icon('chevron-down'));
		this.undoBtn.hidden = this.redoBtn.hidden = !open;
		this.moreBtn.disabled = !open;
		this.view.el.hidden = !open;
		this.tools.hidden = !open;
		if (!open) this.closeMenu();
		this.renderTools();
		this.renderUndo();
		this.renderPresence();
		this.renderMessage();
	}

	renderTools() {
		for (const [tool, el] of this.toolButtons) el.setAttribute('aria-pressed', String(tool === this.view.tool));
		const kind = this.styleKind();
		const style = this.prefs[kind];
		this.swatch.style.setProperty('--ink', style.color);
		this.swatch.style.setProperty('--dot', `${6 + SIZES[kind].indexOf(style.size) * 4}px`);
		this.swatch.dataset.kind = kind;
		this.styleBtn.setAttribute('aria-expanded', String(this.menu === 'style'));
		this.deleteBtn.hidden = !this.view.selected;
	}

	renderUndo() {
		const undoer = this.current ? this.boards?.undoManager(this.current) : null;
		this.undoBtn.disabled = !undoer?.undoStack.length;
		this.redoBtn.disabled = !undoer?.redoStack.length;
	}

	renderMessage() {
		let content = null;
		const spinner = () => h('div', { class: 'spinner', 'aria-hidden': 'true' });
		if (this.loadError) {
			content = [
				h('p', {}, 'Could not load the whiteboard.'),
				button('Try again', null, () => this.load(), 'btn primary'),
			];
		} else if (!this.boards) {
			content = [spinner(), h('p', {}, 'Loading the whiteboard…')];
		} else if (!this.current && this.room.members.length && !this.data.synced && !this.syncWaited) {
			content = [spinner(), h('p', {}, 'Syncing with the room…')];
		} else if (!this.current) {
			content = [
				icon('board'),
				h('p', {}, 'Sketch together with everyone in the room.'),
				h('p', { class: 'hint' }, this.data.persistence
					? 'Draw with a finger, a pen or the mouse, and paste pictures from the clipboard. Boards are kept on every device in the room, and drawings made while apart merge when you meet again.'
					: 'This browser doesn’t let PeerKit save boards, so here they last only while the page is open.'),
				h('div', { class: 'actions' }, button('New board', 'plus', () => this.createBoard(), 'btn primary')),
			];
		}
		this.message.hidden = !content;
		if (content) this.message.replaceChildren(...content);
	}

	/** Who is on this board. Pointer moves change awareness too, so re-render only on a real difference. */
	renderPresence() {
		const states = this.remoteStates().map(({ name, color, board }) => ({ name, color, board }));
		const signature = JSON.stringify([this.current, states]);
		if (signature === this.presenceSignature) return;
		this.presenceSignature = signature;
		const here = states.filter(state => state.board && state.board === this.current);
		this.presence.hidden = !here.length;
		this.presence.replaceChildren(...here.map(state => presenceChip(state, `${state.name} is on this board`)));
		this.sheet?.render();
	}

	// --- popovers: colour and size, adding an image ---

	menuButton() {
		return this.menu === 'image' ? this.imageBtn : this.styleBtn;
	}

	toggleMenu(kind) {
		if (this.menu === kind) {
			this.closeMenu();
			return;
		}
		this.menu = kind;
		this.popover.dataset.menu = kind;
		this.popover.hidden = false;
		this.renderMenu();
		this.renderTools();
	}

	/** Returns whether one was open. */
	closeMenu() {
		if (!this.menu) return false;
		this.menu = null;
		this.popover.hidden = true;
		this.popover.replaceChildren();
		this.renderTools();
		return true;
	}

	renderMenu() {
		if (this.menu === 'style') {
			const kind = this.styleKind();
			const style = this.prefs[kind];
			this.popover.replaceChildren(
				h('div', { class: 'wb-swatches', role: 'group', 'aria-label': kind === 'pen' ? 'Pen colour' : 'Highlighter colour' },
					COLORS.map((color, i) => h('button', {
						type: 'button',
						class: 'wb-color',
						style: `--ink: ${color}`,
						title: COLOR_NAMES[i],
						'aria-label': COLOR_NAMES[i],
						'aria-pressed': String(color === style.color),
						onclick: () => this.setStyle({ color }),
					}))),
				h('div', { class: 'wb-sizes', role: 'group', 'aria-label': 'Size' },
					SIZES[kind].map((size, i) => h('button', {
						type: 'button',
						class: 'wb-size',
						title: SIZE_NAMES[i],
						'aria-label': SIZE_NAMES[i],
						'aria-pressed': String(size === style.size),
						onclick: () => this.setStyle({ size }),
					}, h('span', { style: `--dot: ${6 + i * 4}px` })))));
		} else if (this.menu === 'image') {
			this.popover.replaceChildren(
				button('Paste image', 'clipboard', () => {
					this.closeMenu();
					this.pasteFromClipboard();
				}, 'btn small'),
				button('Choose image', 'upload', () => {
					this.closeMenu();
					this.fileInput.click();
				}, 'btn small'),
				!coarse() && h('p', { class: 'hint' }, 'Or paste with Ctrl+V (⌘V on a Mac), or drop an image on the board.'));
		}
	}

	// --- sheets ---

	showBoards() {
		if (!this.boards) return;
		this.sheet?.dialog.close();
		const list = h('ul', { class: 'doc-list' });
		const render = () => {
			const boards = this.boards?.list() ?? [];
			const states = this.remoteStates();
			list.replaceChildren(...boards.map(board => h('li', {},
				h('button', {
					type: 'button',
					class: 'doc-item',
					'aria-current': String(board.id === this.current),
					onclick: () => {
						dialog.close();
						this.openBoard(board.id);
					},
				},
				h('span', { class: 'doc-item-name' }, board.name),
				h('span', { class: 'doc-item-meta' },
					describeCounts(this.boards.counts(board.id)),
					...states.filter(state => state.board === board.id).map(state => presenceChip(state, `${state.name} is on it`)))))));
			if (!boards.length) list.append(h('li', { class: 'hint' }, 'No boards yet.'));
		};
		const dialog = openDialog(h('div', { class: 'sheet-body' },
			h('h2', {}, 'Boards'),
			list,
			h('div', { class: 'actions end' },
				button('New board', 'plus', () => {
					dialog.close();
					this.createBoard();
				}, 'btn primary'))));
		const sheet = (this.sheet = { dialog, render });
		dialog.addEventListener('close', () => {
			if (this.sheet === sheet) this.sheet = null;
		});
		render();
	}

	showOptions() {
		const id = this.current;
		const board = id && this.boards.read(id);
		if (!board) return;
		const name = h('input', {
			class: 'input',
			value: board.name,
			maxlength: MAX_NAME,
			enterkeyhint: 'done',
			autocomplete: 'off',
			onkeydown: e => {
				if (e.key === 'Enter') {
					e.preventDefault();
					name.blur();
				}
			},
			onchange: () => this.boards?.rename(id, name.value),
		});
		const dialog = openDialog(h('div', { class: 'sheet-body' },
			h('h2', {}, 'Board'),
			h('label', { class: 'field' }, h('span', {}, 'Name'), name),
			h('p', { class: 'hint' }, `${describeCounts(this.boards.counts(id))}. The name changes for everyone.`),
			h('div', { class: 'actions start' },
				this.ctx.handOff && button('Send to Chat', 'send', () => {
					dialog.close();
					this.sendToChat(id);
				}),
				button('Download PNG', 'download', () => this.downloadPng(id)),
				button('Clear', 'eraser', () => {
					if (this.clearBoard(id)) dialog.close();
				}),
				button('Delete', 'trash', () => {
					if (this.deleteBoard(id)) dialog.close();
				}, 'btn small danger')),
			h('div', { class: 'actions end' }, button('Done', null, () => dialog.close(), 'btn primary'))));
		// Esc or the back gesture closes the sheet without a change event.
		dialog.addEventListener('close', () => this.boards?.rename(id, name.value));
	}
}
