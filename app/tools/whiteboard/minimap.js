import { h } from '../../ui/dom.js';
import { itemBounds, unionBounds } from './ink.js';

const PAD = 6; // px inside the map's edge
const MAX_DOTS = 64; // points drawn per stroke at most: the map is a sketch, not a copy
const MAX_COORD = 1e7;

/** A member's view of the board from its awareness state: [x, y, w, h] in board units, or null. */
export function readView(view) {
	if (!Array.isArray(view) || view.length !== 4 || !view.every(Number.isFinite)) return null;
	const [x, y, w, h] = view;
	if (Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD || !(w > 0) || !(h > 0) || w > MAX_COORD || h > MAX_COORD) return null;
	return view;
}

/** How a box of the board fits in a map of w × h px: scale and offset, centred. */
export function mapFrame(box, w, h) {
	const bw = Math.max(1, box.maxX - box.minX);
	const bh = Math.max(1, box.maxY - box.minY);
	const scale = Math.min((w - PAD * 2) / bw, (h - PAD * 2) / bh);
	return { scale, x: box.minX - (w / scale - bw) / 2, y: box.minY - (h / scale - bh) / 2 };
}

const viewBox = ([x, y, w, h]) => ({ minX: x, minY: y, maxX: x + w, maxY: y + h });

/*
 * The minimap in a corner of the board: the drawing as a sketch (strokes as thin lines, images as boxes), this
 * device's view as an outline, and the others' views and pointers in their colours. It frames the drawing and every
 * view, so whoever is far away is still on it. A press or a drag on it moves this device's view there.
 */
export class Minimap {
	/**
	 * @param {object} options
	 * @param {() => object[]} options.items the board's items
	 * @param {() => object[]} options.remote the others on this board: {name, color, view: [x, y, w, h] | null, pointer}
	 * @param {() => number[]} options.view this device's view, [x, y, w, h]
	 * @param {() => boolean} options.visible whether drawing it is worth it now
	 * @param {(x: number, y: number) => void} options.onJump centre this device's view on a board point
	 */
	constructor(options) {
		Object.assign(this, options);
		this.canvas = h('canvas');
		this.el = h('div', { class: 'wb-map', title: 'Map of the board: press to go there', 'aria-hidden': 'true' }, this.canvas);
		this.ctx = null;
		this.frame = null; // the last frame drawn, kept still while dragging
		this.drag = null;
		this.raf = 0;
		this.canvas.addEventListener('pointerdown', e => this.onDown(e));
		this.canvas.addEventListener('pointermove', e => this.onMove(e));
		this.canvas.addEventListener('pointerup', e => this.onUp(e));
		this.canvas.addEventListener('pointercancel', e => this.onUp(e));
	}

	destroy() {
		cancelAnimationFrame(this.raf);
	}

	requestRender() {
		if (!this.raf) this.raf = requestAnimationFrame(() => this.render());
	}

	/** What to show and where: the frame around the drawing and every view. Null when there is nothing to show. */
	layout(w, h) {
		const items = this.items();
		const others = this.remote().filter(state => state.view);
		if (!items.length && !others.length) return null;
		const own = this.view();
		const box = unionBounds([...items.map(itemBounds), viewBox(own), ...others.map(state => viewBox(state.view))]);
		return { items, others, own, frame: this.drag ? this.frame : mapFrame(box, w, h) };
	}

	render() {
		this.raf = 0;
		if (!this.visible()) return;
		// Before the first layout (and in tests) there is no size yet: the size in styles.css.
		const w = this.el.clientWidth || 160;
		const hgt = this.el.clientHeight || 110;
		const shown = this.layout(w, hgt);
		// An empty map keeps its box (visibility, not display), so its size is known when something arrives.
		this.el.classList.toggle('empty', !shown);
		if (!shown) return;
		const dpr = window.devicePixelRatio || 1;
		if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(hgt * dpr)) {
			this.canvas.width = Math.round(w * dpr);
			this.canvas.height = Math.round(hgt * dpr);
		}
		this.ctx ??= this.canvas.getContext('2d');
		const ctx = this.ctx;
		if (!ctx) return;
		const { items, others, own, frame } = shown;
		this.frame = frame;
		const map = (x, y) => [(x - frame.x) * frame.scale, (y - frame.y) * frame.scale];
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, hgt);
		for (const item of items) this.drawItem(ctx, item, map, frame.scale);
		// This device's view: an outline; the others': their colour, faintly filled.
		const rect = ([x, y, vw, vh]) => {
			const [rx, ry] = map(x, y);
			return [rx, ry, vw * frame.scale, vh * frame.scale];
		};
		ctx.lineWidth = 1.5;
		for (const state of others) {
			const r = rect(state.view);
			ctx.globalAlpha = 0.15;
			ctx.fillStyle = state.color;
			ctx.fillRect(...r);
			ctx.globalAlpha = 1;
			ctx.strokeStyle = state.color;
			ctx.strokeRect(...r);
			if (state.pointer) {
				const [px, py] = map(...state.pointer);
				ctx.beginPath();
				ctx.arc(px, py, 2.5, 0, Math.PI * 2);
				ctx.fill();
			}
		}
		ctx.strokeStyle = '#495057';
		ctx.setLineDash([3, 2]);
		ctx.strokeRect(...rect(own));
		ctx.setLineDash([]);
	}

	drawItem(ctx, item, map, scale) {
		if (item.kind === 'image') {
			const [x, y] = map(item.x, item.y);
			ctx.fillStyle = '#dee2e6';
			ctx.fillRect(x, y, Math.max(1, item.w * scale), Math.max(1, item.h * scale));
			return;
		}
		const { points } = item;
		const count = Math.floor(points.length / 3);
		if (!count) return;
		const step = Math.max(1, Math.ceil(count / MAX_DOTS));
		ctx.globalAlpha = item.kind === 'highlighter' ? 0.4 : 1;
		ctx.strokeStyle = item.color;
		ctx.lineWidth = Math.max(1, item.size * scale);
		ctx.lineCap = ctx.lineJoin = 'round';
		ctx.beginPath();
		ctx.moveTo(...map(points[0] + item.x, points[1] + item.y));
		for (let i = step; i < count; i += step) ctx.lineTo(...map(points[i * 3] + item.x, points[i * 3 + 1] + item.y));
		const last = (count - 1) * 3;
		ctx.lineTo(...map(points[last] + item.x, points[last + 1] + item.y));
		ctx.stroke();
		ctx.globalAlpha = 1;
	}

	/** The board point under a press on the map. */
	pointAt(e) {
		const rect = this.canvas.getBoundingClientRect();
		const { frame } = this;
		return { x: (e.clientX - rect.left) / frame.scale + frame.x, y: (e.clientY - rect.top) / frame.scale + frame.y };
	}

	onDown(e) {
		if (!this.frame || (e.button ?? 0) !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		this.drag = e.pointerId;
		this.canvas.setPointerCapture?.(e.pointerId);
		const at = this.pointAt(e);
		this.onJump(at.x, at.y);
	}

	onMove(e) {
		if (this.drag !== e.pointerId) return;
		const at = this.pointAt(e);
		this.onJump(at.x, at.y);
	}

	onUp(e) {
		if (this.drag !== e.pointerId) return;
		this.drag = null;
		this.requestRender(); // the frame may fit the views again
	}
}
