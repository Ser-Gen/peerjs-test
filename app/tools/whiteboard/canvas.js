import { h } from '../../ui/dom.js';
import { decodeImage } from './images.js';
import { MAX_POINTS, evenPressure, hits, itemBounds, overlaps, simplify, unionBounds, widthAt } from './ink.js';

export const PAPER = '#ffffff'; // the board is paper in both colour schemes, so images and ink look the same everywhere
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const ERASER = 10; // px on screen, the eraser's radius
const GRAB = 6; // px on screen: how near a tap must be to pick a thin stroke
const HANDLE = 16; // px on screen, the resize handle of a selected image
const LIVE_EVERY = 66; // ms between updates of the stroke in progress sent to the others
const PINCH_GRACE = 250; // ms: a stroke this young when a second finger lands was the start of a pinch
const SIMPLIFY = 0.5; // px on screen: how far a stored stroke may stray from what was drawn
const FIT_MARGIN = 40; // px
const GRID = 40; // board units between the dots of the grid
const HIGHLIGHT_ALPHA = 0.4;
const TAPER_STEP = 0.75; // board units of width change per piece of a pressed segment

/** Draw a stroke: one smooth path for even pressure (a mouse, a finger, the highlighter), else a segment at a time. */
export function drawStroke(ctx, { kind, color, size, points, x = 0, y = 0 }) {
	const count = Math.floor(points.length / 3);
	if (!count) return;
	ctx.save();
	ctx.translate(x, y);
	ctx.lineCap = ctx.lineJoin = 'round';
	ctx.strokeStyle = ctx.fillStyle = color;
	if (kind === 'highlighter') {
		ctx.globalAlpha = HIGHLIGHT_ALPHA;
		ctx.globalCompositeOperation = 'multiply';
	}
	const width = i => (kind === 'highlighter' ? size : widthAt(size, points[i * 3 + 2]));
	if (count === 1) {
		ctx.beginPath();
		ctx.arc(points[0], points[1], width(0) / 2, 0, Math.PI * 2);
		ctx.fill();
	} else if (kind === 'highlighter' || evenPressure(points)) {
		// One path is painted once, so the highlighter doesn't darken where it crosses itself.
		ctx.lineWidth = width(0);
		ctx.beginPath();
		ctx.moveTo(points[0], points[1]);
		for (let i = 1; i < count - 1; i++) {
			const [px, py, nx, ny] = [points[i * 3], points[i * 3 + 1], points[i * 3 + 3], points[i * 3 + 4]];
			ctx.quadraticCurveTo(px, py, (px + nx) / 2, (py + ny) / 2);
		}
		ctx.lineTo(points[(count - 1) * 3], points[(count - 1) * 3 + 1]);
		ctx.stroke();
	} else {
		for (let i = 1; i < count; i++) {
			const [x0, y0, x1, y1] = [points[i * 3 - 3], points[i * 3 - 2], points[i * 3], points[i * 3 + 1]];
			const [w0, w1] = [width(i - 1), width(i)];
			// A simplified stroke has long segments; the width changes along each in small steps.
			const parts = Math.min(16, Math.max(1, Math.ceil(Math.abs(w1 - w0) / TAPER_STEP)));
			for (let j = 0; j < parts; j++) {
				const [a, b] = [j / parts, (j + 1) / parts];
				ctx.lineWidth = w0 + ((w1 - w0) * (a + b)) / 2;
				ctx.beginPath();
				ctx.moveTo(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a);
				ctx.lineTo(x0 + (x1 - x0) * b, y0 + (y1 - y0) * b);
				ctx.stroke();
			}
		}
	}
	ctx.restore();
}

/** Draw one board item; an image that isn't decoded yet is a grey box. */
export function drawItem(ctx, item, bitmap) {
	if (item.kind !== 'image') return drawStroke(ctx, item);
	if (bitmap) {
		ctx.drawImage(bitmap, item.x, item.y, item.w, item.h);
		return;
	}
	ctx.save();
	ctx.fillStyle = '#f1f3f5';
	ctx.strokeStyle = '#ced4da';
	ctx.lineWidth = 1;
	ctx.fillRect(item.x, item.y, item.w, item.h);
	ctx.strokeRect(item.x, item.y, item.w, item.h);
	ctx.restore();
}

const clampZoom = zoom => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
const round = value => Math.round(value * 10) / 10;

/**
 * The drawing surface of one board: two canvases (what is on the board, and what is live on top of it: strokes
 * in progress, the others' pointers, the selection), a camera, and pointer input. It changes nothing itself:
 * finished strokes, erasing and moving go to the callbacks.
 */
export class BoardView {
	/**
	 * @param {object} options
	 * @param {() => object[]} options.items the board's items, bottom first (boards.js)
	 * @param {() => object[]} options.remote the others on this board: {name, color, pointer: [x, y] | null, stroke | null}
	 * @param {() => boolean} options.visible whether drawing is worth it now
	 * @param {(stroke: object) => void} options.onStroke a finished stroke: {kind, color, size, points}
	 * @param {(maps: object[]) => void} options.onErase
	 * @param {(map: object, x: number, y: number) => void} options.onMove
	 * @param {(map: object, box: object) => void} options.onResize
	 * @param {() => void} options.onSelect the selection changed
	 * @param {(state: {pointer, stroke}) => void} options.onLive what the others should see of this device now
	 * @param {(e: PointerEvent) => boolean} options.blocked true when this press only closes something
	 */
	constructor(options) {
		Object.assign(this, options);
		this.base = h('canvas', { class: 'wb-canvas' });
		this.live = h('canvas', { class: 'wb-canvas' });
		this.el = h('div', { class: 'wb-stage', tabindex: '0', 'aria-label': 'Drawing area', 'data-tool': 'pen' }, this.base, this.live);
		this.baseCtx = this.liveCtx = null; // made on the first drawing: jsdom and hidden tools never need them
		this.camera = { x: 0, y: 0, zoom: 1 };
		this.width = this.height = 0; // CSS px
		this.dpr = 1;
		this.tool = 'pen';
		this.style = { color: '#1e1e1e', size: 4 };
		this.selected = null; // the Y.Map of the selected item
		this.pointers = new Map(); // pointer ID → {x, y, type}, client px
		this.gesture = null;
		this.penSeen = false; // once a stylus draws, fingers pan: a palm on the screen draws nothing
		this.spaceHeld = false;
		this.hover = null; // board point under a mouse or pen that isn't pressed
		this.dirtyBase = this.dirtyLive = false;
		this.frame = 0;
		this.bitmaps = new Map(); // image bytes → {bitmap, promise}
		this.liveTimer = null;
		this.liveSent = 0;
		this.fitPending = false; // opened while out of sight: fit the drawing once the size is known

		const on = (type, fn, opts) => this.el.addEventListener(type, fn, opts);
		on('pointerdown', e => this.onPointerDown(e));
		on('pointermove', e => this.onPointerMove(e));
		on('pointerup', e => this.onPointerUp(e));
		on('pointercancel', e => this.onPointerUp(e));
		// A pointer whose release never comes here (the page hid the board) must not stay pressed.
		on('lostpointercapture', e => {
			if (this.pointers.has(e.pointerId)) this.onPointerUp({ pointerId: e.pointerId, type: 'pointercancel' });
		});
		on('pointerleave', e => this.onLeave(e));
		on('wheel', e => this.onWheel(e), { passive: false });
		on('contextmenu', e => e.preventDefault());
		on('blur', () => (this.spaceHeld = false));
		this.observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.resize()) : null;
		this.observer?.observe(this.el);
	}

	destroy() {
		this.observer?.disconnect();
		cancelAnimationFrame(this.frame);
		clearTimeout(this.liveTimer);
		this.dropBitmaps();
	}

	// --- the board shown ---

	/** Start on a board: at `camera`, or with its drawing in view. */
	open(camera) {
		this.cancelGesture();
		this.selected = null;
		this.dropBitmaps();
		this.resize();
		if (camera) this.setCamera(camera);
		else this.fitContent();
		this.fitPending = !camera && !this.width;
	}

	close() {
		this.cancelGesture();
		this.fitPending = false;
		this.selected = null;
		this.dropBitmaps();
	}

	dropBitmaps() {
		for (const { bitmap } of this.bitmaps.values()) bitmap?.close?.();
		this.bitmaps.clear();
	}

	/** The board changed: draw it again, and let go of a selection that is gone. */
	itemsChanged() {
		if (this.selected && !this.selectedItem()) this.select(null);
		this.requestRender();
	}

	setTool(tool) {
		if (tool === this.tool) return;
		this.cancelGesture();
		this.tool = tool;
		this.el.dataset.tool = tool;
		if (tool !== 'select') this.select(null);
		this.requestRender(false);
	}

	select(map) {
		if (this.selected === map) return;
		this.selected = map;
		this.onSelect?.();
		this.requestRender(false);
	}

	selectedItem() {
		return this.selected ? this.items().find(item => item.map === this.selected) ?? null : null;
	}

	// --- camera ---

	viewSize() {
		// Before the first layout (and in tests) there is no size yet; place things as if on a small laptop.
		return { w: this.width || 800, h: this.height || 600 };
	}

	viewBounds() {
		const { w, h } = this.viewSize();
		const { x, y, zoom } = this.camera;
		return { minX: x, minY: y, maxX: x + w / zoom, maxY: y + h / zoom };
	}

	setCamera({ x, y, zoom }) {
		this.camera = { x, y, zoom: clampZoom(zoom) };
		this.requestRender();
	}

	/** Zoom by `factor`, keeping the board point under (sx, sy) (px from the top-left of the stage) where it is. */
	zoomAt(sx, sy, factor) {
		const { x, y, zoom } = this.camera;
		const next = clampZoom(zoom * factor);
		this.setCamera({ x: x + sx / zoom - sx / next, y: y + sy / zoom - sy / next, zoom: next });
	}

	zoomBy(factor) {
		const { w, h } = this.viewSize();
		this.zoomAt(w / 2, h / 2, factor);
	}

	/** Show the whole drawing, never larger than life; an empty board shows its origin. */
	fitContent() {
		const { w, h } = this.viewSize();
		const box = unionBounds(this.items().map(itemBounds));
		if (!box) return this.setCamera({ x: -FIT_MARGIN, y: -FIT_MARGIN, zoom: 1 });
		const zoom = clampZoom(Math.min(1, (w - FIT_MARGIN * 2) / Math.max(1, box.maxX - box.minX), (h - FIT_MARGIN * 2) / Math.max(1, box.maxY - box.minY)));
		this.setCamera({ x: (box.minX + box.maxX) / 2 - w / 2 / zoom, y: (box.minY + box.maxY) / 2 - h / 2 / zoom, zoom });
	}

	/** Where a new image of w × h pixels goes: at `at` or the middle of the view, at most 60 % of it. */
	placeImage(width, height, at = null, index = 0) {
		const { w, h } = this.viewSize();
		const { zoom } = this.camera;
		const view = this.viewBounds();
		// A screenshot keeps the size it had on this screen.
		let scale = 1 / (window.devicePixelRatio || 1);
		scale = Math.min(scale, (w * 0.6) / zoom / width, (h * 0.6) / zoom / height);
		const bw = Math.max(1, width * scale);
		const bh = Math.max(1, height * scale);
		const center = at ?? { x: (view.minX + view.maxX) / 2, y: (view.minY + view.maxY) / 2 };
		const step = (24 * index) / zoom;
		return { x: round(center.x - bw / 2 + step), y: round(center.y - bh / 2 + step), w: round(bw), h: round(bh) };
	}

	toBoard(clientX, clientY) {
		const rect = this.el.getBoundingClientRect();
		const { x, y, zoom } = this.camera;
		return { x: (clientX - rect.left) / zoom + x, y: (clientY - rect.top) / zoom + y };
	}

	toScreen(x, y) {
		const { camera } = this;
		return { x: (x - camera.x) * camera.zoom, y: (y - camera.y) * camera.zoom };
	}

	// --- drawing ---

	resize() {
		const width = this.el.clientWidth;
		const height = this.el.clientHeight;
		const dpr = window.devicePixelRatio || 1;
		if (!width || !height || (width === this.width && height === this.height && dpr === this.dpr)) return;
		this.width = width;
		this.height = height;
		this.dpr = dpr;
		for (const canvas of [this.base, this.live]) {
			canvas.width = Math.round(width * dpr);
			canvas.height = Math.round(height * dpr);
		}
		if (this.fitPending) {
			this.fitPending = false;
			this.fitContent();
		}
		this.requestRender();
	}

	/** Draw at the next frame: the board too, or (base = false) only what is live on top of it. */
	requestRender(base = true) {
		if (base) this.dirtyBase = true;
		this.dirtyLive = true;
		if (!this.frame) this.frame = requestAnimationFrame(() => this.render());
	}

	render() {
		this.frame = 0;
		if (!this.visible()) return; // stays dirty until it can be seen
		this.baseCtx ??= this.base.getContext('2d');
		this.liveCtx ??= this.live.getContext('2d');
		if (this.dirtyBase && this.baseCtx) this.renderBase(this.baseCtx);
		if (this.dirtyLive && this.liveCtx) this.renderLive(this.liveCtx);
	}

	applyCamera(ctx) {
		const scale = this.dpr * this.camera.zoom;
		ctx.setTransform(scale, 0, 0, scale, -this.camera.x * scale, -this.camera.y * scale);
	}

	renderBase(ctx) {
		this.dirtyBase = false;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.fillStyle = PAPER;
		ctx.fillRect(0, 0, this.base.width, this.base.height);
		this.applyCamera(ctx);
		const view = this.viewBounds();
		this.drawGrid(ctx, view);
		const erasing = this.gesture?.kind === 'erase' ? this.gesture.hit : null;
		for (const stored of this.items()) {
			const item = this.preview(stored);
			if (!overlaps(itemBounds(item), view)) continue;
			if (erasing?.has(item.map)) ctx.globalAlpha = 0.2;
			drawItem(ctx, item, item.kind === 'image' ? this.bitmapFor(item.data) : null);
			ctx.globalAlpha = 1;
		}
	}

	/** Faint dots, so a pan or a zoom can be seen on an empty board. */
	drawGrid(ctx, view) {
		const step = GRID * 2 ** Math.max(0, Math.ceil(Math.log2(12 / (GRID * this.camera.zoom)))); // never closer than 12 px
		const radius = 1.2 / this.camera.zoom;
		ctx.fillStyle = '#dee2e6';
		ctx.beginPath();
		for (let x = Math.floor(view.minX / step) * step; x <= view.maxX; x += step) {
			for (let y = Math.floor(view.minY / step) * step; y <= view.maxY; y += step) {
				ctx.moveTo(x + radius, y);
				ctx.arc(x, y, radius, 0, Math.PI * 2);
			}
		}
		ctx.fill();
	}

	renderLive(ctx) {
		this.dirtyLive = false;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, this.live.width, this.live.height);
		this.applyCamera(ctx);
		const others = this.remote();
		for (const state of others) if (state.stroke) drawStroke(ctx, state.stroke);
		const g = this.gesture;
		if (g?.kind === 'draw') drawStroke(ctx, { kind: g.tool, color: g.color, size: g.size, points: g.points });
		// The rest keeps its size whatever the zoom.
		ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		const item = this.selectedItem();
		if (item) this.drawSelection(ctx, this.preview(item));
		for (const state of others) if (state.pointer) this.drawPointer(ctx, state);
		const eraserAt = g?.kind === 'erase' ? g.last : this.tool === 'eraser' ? this.hover : null;
		if (eraserAt) {
			const at = this.toScreen(eraserAt.x, eraserAt.y);
			ctx.strokeStyle = '#495057';
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.arc(at.x, at.y, ERASER, 0, Math.PI * 2);
			ctx.stroke();
		}
	}

	drawSelection(ctx, item) {
		const box = itemBounds(item);
		const a = this.toScreen(box.minX, box.minY);
		const b = this.toScreen(box.maxX, box.maxY);
		ctx.strokeStyle = '#2f6fed';
		ctx.lineWidth = 1.5;
		ctx.setLineDash([5, 4]);
		ctx.strokeRect(a.x - 4, a.y - 4, b.x - a.x + 8, b.y - a.y + 8);
		ctx.setLineDash([]);
		if (item.kind === 'image') {
			ctx.fillStyle = '#ffffff';
			ctx.fillRect(b.x - HANDLE / 2, b.y - HANDLE / 2, HANDLE, HANDLE);
			ctx.strokeRect(b.x - HANDLE / 2, b.y - HANDLE / 2, HANDLE, HANDLE);
		}
	}

	drawPointer(ctx, { name, color, pointer }) {
		const at = this.toScreen(pointer[0], pointer[1]);
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.arc(at.x, at.y, 4, 0, Math.PI * 2);
		ctx.fill();
		ctx.font = '600 12px system-ui, sans-serif';
		const width = ctx.measureText?.(name)?.width ?? name.length * 7;
		ctx.fillRect(at.x + 7, at.y + 6, width + 10, 18);
		ctx.fillStyle = '#ffffff';
		ctx.fillText(name, at.x + 12, at.y + 19);
	}

	/** A decoded image, or null while it decodes (it is drawn again when it is ready). */
	bitmapFor(data) {
		return this.loadBitmap(data).bitmap;
	}

	loadBitmap(data) {
		let entry = this.bitmaps.get(data);
		if (entry) return entry;
		entry = { bitmap: null, promise: null };
		this.bitmaps.set(data, entry);
		entry.promise = decodeImage(data).then(bitmap => {
			if (this.bitmaps.get(data) !== entry) {
				bitmap.close?.();
				return null;
			}
			entry.bitmap = bitmap;
			this.requestRender();
			return bitmap;
		}, () => null); // stays a grey box
		return entry;
	}

	/** An item as it looks during a move or a resize that isn't finished yet. */
	preview(item) {
		const g = this.gesture;
		if (!g || g.item?.map !== item.map) return item;
		if (g.kind === 'move') return { ...item, x: item.x + g.dx, y: item.y + g.dy };
		if (g.kind === 'resize') return { ...item, ...g.box };
		return item;
	}

	// --- input ---

	onPointerDown(e) {
		if (this.blocked?.(e)) return;
		this.el.focus({ preventScroll: true });
		if (e.pointerType === 'pen') this.penSeen = true;
		this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
		this.el.setPointerCapture?.(e.pointerId); // its release comes here wherever it happens
		const touches = [...this.pointers.entries()].filter(([, p]) => p.type === 'touch');
		if (e.pointerType === 'touch' && touches.length === 2) return this.startPinch(touches.map(([id]) => id));
		if (this.gesture || this.pointers.size > 1 || e.button > 1) return;
		const at = this.toBoard(e.clientX, e.clientY);
		this.hover = null;
		if (e.button === 1 || this.spaceHeld || (e.pointerType === 'touch' && this.penSeen && this.tool !== 'select')) return this.startPan(e);
		if (this.tool === 'pen' || this.tool === 'highlighter') return this.startDraw(e);
		if (this.tool === 'eraser') return this.startErase(e, at);
		return this.startSelect(e, at);
	}

	onPointerMove(e) {
		const pointer = this.pointers.get(e.pointerId);
		if (pointer) Object.assign(pointer, { x: e.clientX, y: e.clientY });
		const g = this.gesture;
		if (g?.kind === 'pinch') return this.movePinch();
		if (!g || g.id !== e.pointerId) {
			// A mouse or a pen that isn't pressed: the others see where it points, and the eraser shows its size.
			if (!pointer && e.pointerType !== 'touch') {
				this.hover = this.toBoard(e.clientX, e.clientY);
				this.el.style.cursor = this.cursorAt(this.hover);
				this.sendLive();
				if (this.tool === 'eraser') this.requestRender(false);
			}
			return;
		}
		const at = this.toBoard(e.clientX, e.clientY);
		if (g.kind === 'draw') this.moveDraw(e);
		else if (g.kind === 'erase') this.moveErase(at);
		else if (g.kind === 'move') {
			g.dx = at.x - g.start.x;
			g.dy = at.y - g.start.y;
			this.requestRender();
		} else if (g.kind === 'resize') {
			const { x, y, w, h } = g.item;
			const width = Math.max(16 / this.camera.zoom, w + at.x - g.start.x);
			g.box = { x, y, w: round(width), h: round((width * h) / w) };
			this.requestRender();
		} else if (g.kind === 'pan') {
			this.setCamera({ ...this.camera, x: g.camera.x - (e.clientX - g.sx) / this.camera.zoom, y: g.camera.y - (e.clientY - g.sy) / this.camera.zoom });
		}
	}

	onPointerUp(e) {
		this.pointers.delete(e.pointerId);
		const g = this.gesture;
		if (g?.kind === 'pinch' || g?.kind === 'wait') {
			// The fingers still down after a pinch do nothing until they are lifted.
			this.gesture = this.pointers.size ? { kind: 'wait' } : null;
			return;
		}
		if (!g || g.id !== e.pointerId) return;
		this.finishGesture(e.type === 'pointerup');
		this.el.style.cursor = '';
	}

	onLeave(e) {
		if (e.pointerType === 'touch' || this.gesture) return;
		this.hover = null;
		this.sendLive();
		this.requestRender(false);
	}

	onWheel(e) {
		e.preventDefault();
		const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.viewSize().h : 1;
		let dx = e.deltaX * unit;
		let dy = e.deltaY * unit;
		if (e.ctrlKey || e.metaKey) {
			// A pinch on a touchpad arrives as a wheel with Ctrl.
			const rect = this.el.getBoundingClientRect();
			this.zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-Math.max(-100, Math.min(100, dy)) / 300));
			return;
		}
		if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
		const { x, y, zoom } = this.camera;
		this.setCamera({ x: x + dx / zoom, y: y + dy / zoom, zoom });
	}

	cursorAt(at) {
		if (this.spaceHeld) return 'grab';
		if (this.tool === 'eraser') return 'none';
		if (this.tool !== 'select') return 'crosshair';
		const item = this.selectedItem();
		if (item?.kind === 'image' && this.onHandle(item, at)) return 'nwse-resize';
		return this.itemAt(at) ? 'move' : 'grab';
	}

	// --- gestures ---

	startDraw(e) {
		const { color, size } = this.style;
		this.gesture = { kind: 'draw', tool: this.tool, id: e.pointerId, color, size, points: [], pressure: e.pointerType === 'pen', started: performance.now() };
		this.addPoints(e);
		this.requestRender(false);
		this.sendLive();
	}

	addPoints(e) {
		const g = this.gesture;
		const events = e.getCoalescedEvents?.() ?? [];
		const min = 0.5 / this.camera.zoom;
		for (const ev of events.length ? events : [e]) {
			const { x, y } = this.toBoard(ev.clientX, ev.clientY);
			const n = g.points.length;
			if (n && Math.abs(g.points[n - 3] - x) < min && Math.abs(g.points[n - 2] - y) < min) continue;
			const pressure = g.pressure && ev.pressure > 0 ? Math.min(1, ev.pressure) : 0.5;
			g.points.push(x, y, pressure);
			if (g.points.length >= MAX_POINTS * 3) {
				// A very long stroke goes on as a new one from where it got to.
				const last = g.points.slice(-3);
				this.commitStroke(g);
				g.points = last;
			}
		}
	}

	moveDraw(e) {
		this.addPoints(e);
		this.requestRender(false);
		this.sendLive();
	}

	commitStroke(g) {
		if (!g.points.length) return;
		this.onStroke({ kind: g.tool, color: g.color, size: g.size, points: simplify(g.points, SIMPLIFY / this.camera.zoom) });
	}

	startErase(e, at) {
		this.gesture = { kind: 'erase', id: e.pointerId, hit: new Set(), last: at };
		this.moveErase(at);
	}

	moveErase(at) {
		const g = this.gesture;
		const radius = ERASER / this.camera.zoom;
		const from = g.last;
		const steps = Math.max(1, Math.ceil(Math.hypot(at.x - from.x, at.y - from.y) / (radius / 2)));
		let added = false;
		for (const item of this.items()) {
			if (g.hit.has(item.map)) continue;
			for (let i = 0; i <= steps; i++) {
				const t = i / steps;
				if (hits(item, from.x + (at.x - from.x) * t, from.y + (at.y - from.y) * t, radius)) {
					g.hit.add(item.map);
					added = true;
					break;
				}
			}
		}
		g.last = at;
		this.requestRender(added);
	}

	startSelect(e, at) {
		const selected = this.selectedItem();
		if (selected?.kind === 'image' && this.onHandle(selected, at)) {
			this.gesture = { kind: 'resize', id: e.pointerId, item: selected, start: at, box: { x: selected.x, y: selected.y, w: selected.w, h: selected.h } };
			return;
		}
		const item = this.itemAt(at);
		if (!item) {
			this.select(null);
			return this.startPan(e);
		}
		this.select(item.map);
		this.gesture = { kind: 'move', id: e.pointerId, item, start: at, dx: 0, dy: 0 };
	}

	/** The topmost item under a board point. */
	itemAt(at) {
		const items = this.items();
		const radius = GRAB / this.camera.zoom;
		for (let i = items.length - 1; i >= 0; i--) if (hits(items[i], at.x, at.y, radius)) return items[i];
		return null;
	}

	onHandle(item, at) {
		const reach = HANDLE / this.camera.zoom;
		return Math.abs(at.x - (item.x + item.w)) <= reach && Math.abs(at.y - (item.y + item.h)) <= reach;
	}

	startPan(e) {
		this.gesture = { kind: 'pan', id: e.pointerId, sx: e.clientX, sy: e.clientY, camera: { ...this.camera } };
		this.el.style.cursor = 'grabbing';
	}

	startPinch(ids) {
		const g = this.gesture;
		// A stroke that just began was the first finger of the pinch; an older one was meant.
		if (g?.kind === 'draw' && performance.now() - g.started >= PINCH_GRACE) this.commitStroke(g);
		this.gesture = null;
		const [a, b] = ids.map(id => this.pointers.get(id));
		const rect = this.el.getBoundingClientRect();
		const mid = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
		this.gesture = {
			kind: 'pinch',
			ids,
			distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
			zoom: this.camera.zoom,
			anchor: { x: mid.x / this.camera.zoom + this.camera.x, y: mid.y / this.camera.zoom + this.camera.y },
		};
		this.sendLive(true);
		this.requestRender();
	}

	movePinch() {
		const g = this.gesture;
		const [a, b] = g.ids.map(id => this.pointers.get(id));
		if (!a || !b) return;
		const rect = this.el.getBoundingClientRect();
		const mid = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
		const zoom = clampZoom((g.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / g.distance);
		this.setCamera({ x: g.anchor.x - mid.x / zoom, y: g.anchor.y - mid.y / zoom, zoom });
	}

	finishGesture(commit) {
		const g = this.gesture;
		this.gesture = null;
		if (commit) {
			if (g.kind === 'draw') {
				this.commitStroke(g);
			} else if (g.kind === 'erase' && g.hit.size) {
				this.onErase([...g.hit]);
			} else if (g.kind === 'move' && (g.dx || g.dy)) {
				this.onMove(g.item.map, round(g.item.x + g.dx), round(g.item.y + g.dy));
			} else if (g.kind === 'resize' && (g.box.w !== g.item.w || g.box.h !== g.item.h)) {
				this.onResize(g.item.map, g.box);
			}
		}
		this.sendLive(true);
		this.requestRender();
	}

	/** Drop what is in progress without keeping it. */
	cancelGesture() {
		if (!this.gesture) return;
		this.gesture = null;
		this.pointers.clear();
		this.sendLive(true);
		this.requestRender();
	}

	// --- what the others see ---

	/** The stroke in progress and where this device points, at most every LIVE_EVERY ms; `now` sends at once. */
	sendLive(now = false) {
		clearTimeout(this.liveTimer);
		this.liveTimer = null;
		const wait = LIVE_EVERY - (performance.now() - this.liveSent);
		if (!now && wait > 0) {
			this.liveTimer = setTimeout(() => this.sendLive(true), wait);
			return;
		}
		this.liveSent = performance.now();
		const g = this.gesture;
		let stroke = null;
		let pointer = this.hover ? [round(this.hover.x), round(this.hover.y)] : null;
		if (g?.kind === 'draw' && g.points.length) {
			const points = simplify(g.points, (SIMPLIFY * 2) / this.camera.zoom).map((value, i) => (i % 3 === 2 ? Math.round(value * 100) / 100 : round(value)));
			stroke = { kind: g.tool, color: g.color, size: g.size, points };
			pointer = points.slice(-3, -1);
		}
		this.onLive?.({ pointer, stroke });
	}
}
