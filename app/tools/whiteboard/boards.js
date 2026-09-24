import { Emitter } from '../../emitter.js';
import { randomId } from '../../util.js';
import { packPoints, unpackPoints } from './ink.js';

export const MAX_NAME = 80;
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // an image from a member; this device makes them 2 MB at most
export const MAX_IMAGES = 40; // images this device adds to one board
const MAX_ITEMS = 20000; // items drawn per board
const MAX_SIZE = 200;
const MAX_EXTENT = 1e7;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const INK = '#1e1e1e';

/** The origin of this device's own changes: undo follows only these, so it never takes back someone else's stroke. */
export const LOCAL = Object.freeze({ whiteboard: 'local' });

/*
 * Data (the whiteboard's own Y.Doc per room, app/roomdoc.js: IndexedDB `peerkit.board:<room ID>`, ch 'board'):
 *   map 'boards': id → Y.Map { name, created: ms, items: Y.Array of Y.Map }
 *   a stroke: { kind: 'pen' | 'highlighter', from: device ID, time, x, y, color: '#rrggbb', size,
 *               points: Uint8Array of little-endian float32 (x, y, pressure) triples, see ink.js }
 *   an image: { kind: 'image', from, time, x, y, w, h, data: Uint8Array (PNG, WebP or JPEG) }
 * x and y move a stroke (its points stay as drawn); for an image they are its top-left corner. Items are drawn in
 * array order. Every value is checked when it is read (readItem): any member can write anything.
 */

export const cleanBoardName = value => String(value ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);

const coord = value => (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_EXTENT ? value : null);
const extent = value => (typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= MAX_EXTENT ? value : null);

/** An item as it can be drawn, or null when it isn't one. */
export function readItem(Y, map) {
	if (!(map instanceof Y.Map)) return null;
	const kind = map.get('kind');
	const x = coord(map.get('x'));
	const y = coord(map.get('y'));
	if (x === null || y === null) return null;
	if (kind === 'image') {
		const w = extent(map.get('w'));
		const h = extent(map.get('h'));
		const data = map.get('data');
		if (w === null || h === null || !(data instanceof Uint8Array) || !data.length || data.length > MAX_IMAGE_BYTES) return null;
		return { map, kind, x, y, w, h, data };
	}
	if (kind !== 'pen' && kind !== 'highlighter') return null;
	const points = unpackPoints(map.get('points'));
	const size = map.get('size');
	if (!points || typeof size !== 'number' || !(size >= 0.5 && size <= MAX_SIZE)) return null;
	const color = map.get('color');
	return { map, kind, x, y, size, color: COLOR_RE.test(color) ? color : INK, points };
}

/**
 * The boards of a room, over the whiteboard's Y.Doc. Events: 'change' (transaction) after anything changed,
 * 'undo' (board id) when what can be undone or redone there changed.
 */
export class Boards extends Emitter {
	constructor(lib, doc, self) {
		super();
		this.Y = lib.Y;
		this.doc = doc;
		this.self = self;
		this.map = doc.getMap('boards');
		this.cache = new Map(); // board id → its items, read once per change
		this.undoers = new Map(); // board id → Y.UndoManager
		this.map.observe(event => {
			for (const [id, change] of event.changes.keys) if (change.action !== 'add') this.forget(id);
		});
		this.onChange = (events, transaction) => {
			this.cache.clear();
			this.emit('change', transaction);
		};
		this.map.observeDeep(this.onChange);
	}

	destroy() {
		this.map.unobserveDeep(this.onChange);
		for (const id of [...this.undoers.keys()]) this.forget(id);
	}

	// --- boards ---

	entry(id) {
		const entry = this.map.get(id);
		return entry instanceof this.Y.Map && entry.get('items') instanceof this.Y.Array ? entry : null;
	}

	read(id) {
		const entry = this.entry(id);
		if (!entry) return null;
		const created = entry.get('created');
		return { id, name: cleanBoardName(entry.get('name')) || 'Untitled board', created: Number.isFinite(created) ? created : 0 };
	}

	list() {
		return [...this.map.keys()]
			.map(id => this.read(id))
			.filter(Boolean)
			.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.created - b.created);
	}

	untitledName() {
		const names = new Set(this.list().map(board => board.name));
		let n = 1;
		while (names.has(`Board ${n}`)) n++;
		return `Board ${n}`;
	}

	create(name = '') {
		const { Y } = this;
		const id = randomId(8);
		this.doc.transact(() => {
			const entry = new Y.Map();
			this.map.set(id, entry);
			entry.set('name', cleanBoardName(name) || this.untitledName());
			entry.set('created', Date.now());
			entry.set('items', new Y.Array());
		}, LOCAL);
		return id;
	}

	rename(id, value) {
		const name = cleanBoardName(value);
		const entry = this.entry(id);
		if (name && entry && entry.get('name') !== name) this.doc.transact(() => entry.set('name', name), LOCAL);
	}

	remove(id) {
		this.forget(id);
		this.doc.transact(() => this.map.delete(id), LOCAL);
	}

	// --- items ---

	/** The items of a board that can be drawn, bottom first. */
	items(id) {
		if (this.cache.has(id)) return this.cache.get(id);
		const array = this.entry(id)?.get('items');
		const items = [];
		if (array) {
			for (const map of array) {
				const item = readItem(this.Y, map);
				if (item) items.push(item);
				if (items.length >= MAX_ITEMS) break;
			}
		}
		this.cache.set(id, items);
		return items;
	}

	counts(id) {
		const counts = { strokes: 0, images: 0 };
		for (const item of this.items(id)) counts[item.kind === 'image' ? 'images' : 'strokes']++;
		return counts;
	}

	/** Change a board as this device: one undo step. */
	change(id, fn) {
		const items = this.entry(id)?.get('items');
		if (!items) return null;
		this.undoManager(id); // it must exist before the change to see it
		let result = null;
		this.doc.transact(() => {
			result = fn(items);
		}, LOCAL);
		return result;
	}

	add(id, fields) {
		return this.change(id, items => {
			const map = new this.Y.Map();
			for (const [key, value] of Object.entries({ ...fields, from: this.self, time: Date.now() })) map.set(key, value);
			items.push([map]);
			return map;
		});
	}

	/** `points` is [x, y, pressure, …] in board units. */
	addStroke(id, { kind, color, size, points }) {
		return this.add(id, { kind, x: 0, y: 0, color, size, points: packPoints(points) });
	}

	addImage(id, { x, y, w, h, data }) {
		return this.add(id, { kind: 'image', x, y, w, h, data });
	}

	move(id, map, x, y) {
		this.change(id, items => {
			if (!items.toArray().includes(map)) return; // erased meanwhile, here or elsewhere
			map.set('x', x);
			map.set('y', y);
		});
	}

	resize(id, map, { x, y, w, h }) {
		this.change(id, items => {
			if (!items.toArray().includes(map)) return;
			map.set('x', x);
			map.set('y', y);
			map.set('w', w);
			map.set('h', h);
		});
	}

	erase(id, maps) {
		const gone = new Set(maps);
		this.change(id, items => {
			const all = items.toArray();
			for (let i = all.length - 1; i >= 0; i--) if (gone.has(all[i])) items.delete(i, 1);
		});
	}

	clear(id) {
		this.change(id, items => items.delete(0, items.length));
	}

	// --- undo: this device's own changes, per board ---

	undoManager(id) {
		let undoer = this.undoers.get(id);
		const items = this.entry(id)?.get('items');
		if (undoer || !items) return undoer ?? null;
		// Every stroke, erase or move is one transaction, and each is its own step.
		undoer = new this.Y.UndoManager(items, { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
		const changed = () => this.emit('undo', id);
		for (const type of ['stack-item-added', 'stack-item-popped', 'stack-cleared']) undoer.on(type, changed);
		this.undoers.set(id, undoer);
		return undoer;
	}

	forget(id) {
		const undoer = this.undoers.get(id);
		if (!undoer) return;
		this.undoers.delete(id);
		undoer.destroy();
		this.emit('undo', id);
	}
}
