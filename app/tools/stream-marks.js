import { h } from '../ui/dom.js';
import { randomId } from '../util.js';

/*
 * Marks on a stream: pointers with a name, and strokes that fade. Positions are fractions (0–1) of the video
 * picture, not of the element, so letterboxing, a portrait phone and a mirrored preview all line up.
 *
 * On the wire (ch 'stream', see stream.js) one message carries whatever changed since the last one, at most
 * 30 a second:
 *   mark {id, pt?, st?, clear?, by?}
 *     pt     [x, y] the pointer is here; null: it went away
 *     st     {s, p: [x, y, x, y, …], e}: points added to stroke s; e ends it
 *     clear  true: every stroke on this stream goes, for everyone
 *     by     set by the sender when it passes a viewer's marks on: whose they are
 */

export const MARK_TIMING = {
	send: 33, // at most 30 messages a second
	keep: 2000, // a pointer that doesn't move is sent again this often, so its idle timeout doesn't take it away
	idle: 6000, // a pointer not heard from for this long goes away (its "gone" was lost)
	hold: 3000, // a finished stroke stays this long…
	fade: 1000, // …then fades out over this long
	stale: 5000, // a stroke whose end never came counts as finished this long after its last points
};
const MAX_BATCH = 400; // numbers in one message's stroke: 200 points
const MAX_POINTS = 4000; // per stroke; more are ignored
const MAX_STROKES = 200; // per stream; the oldest go first
const MIN_STEP = 0.002; // a local point closer than this to the last one isn't sent

const frac = v => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);
const round = v => Math.round(v * 10000) / 10000;
const readStrokeId = s => (typeof s === 'string' && /^[0-9a-z]{1,16}$/.test(s) ? s : null);
export const readPeerId = id => (typeof id === 'string' && /^[\w-]{1,64}$/.test(id) ? id : null);

/** A `mark` message's content, checked; null if there is nothing usable in it. */
export function readMark(msg) {
	const mark = {};
	if (msg.clear === true) mark.clear = true;
	if (msg.pt === null) mark.pt = null;
	else if (Array.isArray(msg.pt) && msg.pt.length === 2) {
		const [x, y] = msg.pt.map(frac);
		if (x !== null && y !== null) mark.pt = [x, y];
	}
	const st = msg.st;
	const s = readStrokeId(st?.s);
	if (s && Array.isArray(st.p) && st.p.length % 2 === 0 && st.p.length <= MAX_BATCH) {
		const p = st.p.map(frac);
		if (!p.includes(null)) mark.st = { s, p, e: st.e === true };
	}
	return Object.keys(mark).length ? mark : null;
}

/**
 * What this device marks on one stream, batched: whatever changes within MARK_TIMING.send goes out in one message.
 */
export class MarkOutbox {
	constructor(send) {
		this.send = send;
		this.pending = {};
		this.last = 0;
		this.timer = null;
		this.keepTimer = null;
		this.pointer = null; // where this device's pointer is, while it points
	}

	point(x, y) {
		this.pointer = [round(x), round(y)];
		this.pending.pt = this.pointer;
		this.queue();
	}

	unpoint() {
		if (!this.pointer) return;
		this.pointer = null;
		this.pending.pt = null;
		this.queue();
	}

	stroke(s, x, y, end = false) {
		// One stroke per message: a new one sends what is left of the one before first.
		if (this.pending.st && this.pending.st.s !== s) this.flush();
		const st = (this.pending.st ??= { s, p: [], e: false });
		if (x != null) st.p.push(round(x), round(y));
		if (end) st.e = true;
		if (st.p.length >= MAX_BATCH - 2 || end) this.flush();
		else this.queue();
	}

	clear() {
		delete this.pending.st;
		this.pending.clear = true;
		this.flush();
	}

	queue() {
		if (this.timer) return;
		const wait = this.last + MARK_TIMING.send - Date.now();
		if (wait <= 0) this.flush();
		else this.timer = setTimeout(() => this.flush(), wait);
	}

	flush() {
		clearTimeout(this.timer);
		this.timer = null;
		const mark = this.pending;
		this.pending = {};
		if (!Object.keys(mark).length) return;
		this.last = Date.now();
		this.send(mark);
		// A pointer held still is sent again now and then: on the other side it goes away when it isn't heard from.
		clearTimeout(this.keepTimer);
		this.keepTimer = this.pointer ? setTimeout(() => this.point(...this.pointer), MARK_TIMING.keep) : null;
	}

	destroy() {
		clearTimeout(this.timer);
		clearTimeout(this.keepTimer);
		this.timer = this.keepTimer = null;
		this.pending = {};
		this.pointer = null;
	}
}

/**
 * The marks drawn over one video element: a canvas for the strokes and a label per pointer. With a mode on
 * ('point' or 'draw') it also takes this device's own pointer input and hands it to an outbox.
 */
export class MarkLayer {
	/**
	 * @param video the element the marks sit on
	 * @param whoOf by → {name, color}, asked at every paint, so a rename shows at once
	 * @param mirrored () → true while the video is shown mirrored (your own front camera)
	 * @param onChange called when there come to be strokes, or none
	 */
	constructor(video, { whoOf, mirrored = () => false, onChange = () => {} }) {
		this.video = video;
		this.whoOf = whoOf;
		this.mirrored = mirrored;
		this.onChange = onChange;
		this.pointers = new Map(); // by → { x, y, time, el }
		this.strokes = new Map(); // `${by} ${s}` → { by, points: [x, y, …], last, ended }
		this.mode = null;
		this.outbox = null;
		this.drawing = null; // { pointerId, s, x, y } while this device draws
		this.frame = null;
		this.context = null;
		this.canvas = h('canvas', { class: 'marks-canvas', 'aria-hidden': 'true' });
		this.el = h('div', { class: 'marks' }, this.canvas);
		for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture']) {
			this.el.addEventListener(type, e => this.onPointer(e));
		}
	}

	get hasStrokes() {
		return this.strokes.size > 0;
	}

	// --- marks from the others (and this device's own strokes) ---

	point(by, x, y) {
		let pointer = this.pointers.get(by);
		if (!pointer) {
			pointer = { el: h('div', { class: 'mark-pointer' }, h('span', { class: 'mark-dot' }), h('span', { class: 'mark-name' })) };
			this.pointers.set(by, pointer);
			this.el.append(pointer.el);
		}
		Object.assign(pointer, { x, y, time: Date.now() });
		this.schedule();
	}

	unpoint(by) {
		const pointer = this.pointers.get(by);
		if (!pointer) return;
		this.pointers.delete(by);
		pointer.el.remove();
	}

	stroke(by, s, points, end) {
		const key = `${by} ${s}`;
		let stroke = this.strokes.get(key);
		if (!stroke) {
			if (!points.length && end) return;
			const had = this.hasStrokes;
			while (this.strokes.size >= MAX_STROKES) this.strokes.delete(this.strokes.keys().next().value);
			stroke = { by, points: [], last: 0, ended: null };
			this.strokes.set(key, stroke);
			if (!had) this.onChange();
		}
		if (stroke.ended) return;
		const room = MAX_POINTS * 2 - stroke.points.length;
		if (room > 0) stroke.points.push(...points.slice(0, room));
		stroke.last = Date.now();
		if (end) stroke.ended = stroke.last;
		this.schedule();
	}

	/** Every stroke goes; pointers stay where they are. */
	clear() {
		if (this.drawing) this.drawing.s = null; // the rest of a stroke being drawn isn't sent
		const had = this.hasStrokes;
		this.strokes.clear();
		this.schedule();
		if (had) this.onChange();
	}

	apply(by, mark) {
		if (mark.clear) this.clear();
		if (mark.pt === null) this.unpoint(by);
		else if (mark.pt) this.point(by, ...mark.pt);
		if (mark.st) this.stroke(by, mark.st.s, mark.st.p, mark.st.e);
	}

	/** Everything, and this device's mode: the stream ended or was closed. */
	reset() {
		this.setMode(null);
		for (const by of [...this.pointers.keys()]) this.unpoint(by);
		this.clear();
	}

	// --- drawing ---

	schedule() {
		if (this.frame != null) return;
		this.frame = requestAnimationFrame(() => {
			this.frame = null;
			this.paint();
		});
	}

	/** Where the picture is inside the element, in CSS pixels, after object-fit. */
	box() {
		const width = this.el.clientWidth;
		const height = this.el.clientHeight;
		if (!width || !height) return null;
		const { videoWidth: vw, videoHeight: vh } = this.video;
		if (!vw || !vh) return { left: 0, top: 0, width, height };
		const fit = getComputedStyle(this.video).objectFit;
		if (fit === 'fill') return { left: 0, top: 0, width, height };
		const scale = fit === 'cover' ? Math.max(width / vw, height / vh) : Math.min(width / vw, height / vh);
		return { left: (width - vw * scale) / 2, top: (height - vh * scale) / 2, width: vw * scale, height: vh * scale };
	}

	/** A picture fraction to a place in the element. */
	at(box, x, y) {
		return [box.left + (this.mirrored() ? 1 - x : x) * box.width, box.top + y * box.height];
	}

	paint() {
		const now = Date.now();
		let changed = false;
		for (const [key, stroke] of this.strokes) {
			const ended = stroke.ended ?? (now - stroke.last > MARK_TIMING.stale ? stroke.last : null);
			if (ended != null && now - ended > MARK_TIMING.hold + MARK_TIMING.fade) {
				this.strokes.delete(key);
				changed = true;
			}
		}
		for (const [by, pointer] of this.pointers) if (now - pointer.time > MARK_TIMING.idle) this.unpoint(by);

		const box = this.el.isConnected ? this.box() : null;
		if (box) {
			for (const [by, pointer] of this.pointers) {
				const who = this.whoOf(by);
				const [px, py] = this.at(box, pointer.x, pointer.y);
				pointer.el.style.left = `${px}px`;
				pointer.el.style.top = `${py}px`;
				pointer.el.style.setProperty('--mark', who.color);
				const name = pointer.el.lastChild;
				if (name.textContent !== who.name) name.textContent = who.name;
			}
			this.paintStrokes(box, now);
		}
		if (changed && !this.hasStrokes) this.onChange();
		// Keep going while something may fade or time out; a still pointer only needs its idle check.
		if (this.strokes.size) this.schedule();
		else if (this.pointers.size) {
			clearTimeout(this.idleTimer);
			this.idleTimer = setTimeout(() => this.schedule(), 500);
		}
	}

	paintStrokes(box, now) {
		const ratio = window.devicePixelRatio || 1;
		const width = Math.round(this.el.clientWidth * ratio);
		const height = Math.round(this.el.clientHeight * ratio);
		if (this.canvas.width !== width) this.canvas.width = width;
		if (this.canvas.height !== height) this.canvas.height = height;
		this.context ??= this.canvas.getContext('2d');
		const g = this.context;
		if (!g) return;
		g.setTransform(ratio, 0, 0, ratio, 0, 0);
		g.clearRect(0, 0, width, height);
		g.lineCap = 'round';
		g.lineJoin = 'round';
		g.lineWidth = Math.max(2.5, box.width * 0.005);
		for (const stroke of this.strokes.values()) {
			const ended = stroke.ended ?? (now - stroke.last > MARK_TIMING.stale ? stroke.last : null);
			const age = ended == null ? 0 : now - ended - MARK_TIMING.hold;
			g.globalAlpha = age <= 0 ? 1 : Math.max(0, 1 - age / MARK_TIMING.fade);
			g.strokeStyle = this.whoOf(stroke.by).color;
			const p = stroke.points;
			if (!p.length) continue;
			g.beginPath();
			g.moveTo(...this.at(box, p[0], p[1]));
			// A single point is a dot.
			if (p.length === 2) g.lineTo(...this.at(box, p[0], p[1]));
			for (let i = 2; i < p.length; i += 2) g.lineTo(...this.at(box, p[i], p[i + 1]));
			g.stroke();
		}
		g.globalAlpha = 1;
	}

	// --- this device's own input ---

	/** 'point', 'draw' or null; the outbox gets what this device marks. */
	setMode(mode, outbox = this.outbox) {
		this.endStroke();
		this.outbox?.unpoint();
		this.mode = mode;
		this.outbox = outbox;
		this.el.classList.toggle('marking', Boolean(mode));
		this.el.dataset.mode = mode ?? '';
	}

	/** A place on the screen as a picture fraction, clamped to the picture. */
	toPicture(e) {
		const box = this.box();
		if (!box || !box.width || !box.height) return null;
		const rect = this.el.getBoundingClientRect();
		let x = (e.clientX - rect.left - box.left) / box.width;
		const y = (e.clientY - rect.top - box.top) / box.height;
		if (this.mirrored()) x = 1 - x;
		return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
	}

	onPointer(e) {
		if (!this.mode || !this.outbox) return;
		if (this.mode === 'point') return this.onPoint(e);
		if (this.mode === 'draw') return this.onDraw(e);
	}

	onPoint(e) {
		// A mouse (or a hovering pen) points by moving over the picture; a finger while it touches.
		const touch = e.pointerType === 'touch';
		if (e.type === 'pointerleave' || e.type === 'pointercancel' || (touch && e.type === 'pointerup')) {
			this.outbox.unpoint();
			return;
		}
		if (e.type === 'pointerdown' || e.type === 'pointermove') {
			if (touch && e.type === 'pointermove' && !this.outbox.pointer) return;
			const at = this.toPicture(e);
			if (at) this.outbox.point(...at);
			if (e.type === 'pointerdown') e.preventDefault();
		}
	}

	onDraw(e) {
		if (e.type === 'pointerdown') {
			if (e.button !== 0 || this.drawing) return;
			e.preventDefault();
			try {
				this.el.setPointerCapture?.(e.pointerId);
			} catch {
				// a synthetic pointer
			}
			const at = this.toPicture(e);
			if (!at) return;
			this.drawing = { pointerId: e.pointerId, s: randomId(4), x: at[0], y: at[1] };
			this.addOwn(at, false);
			return;
		}
		if (!this.drawing || e.pointerId !== this.drawing.pointerId) return;
		if (e.type === 'pointermove') {
			const at = this.toPicture(e);
			if (at && Math.hypot(at[0] - this.drawing.x, at[1] - this.drawing.y) >= MIN_STEP) {
				this.drawing.x = at[0];
				this.drawing.y = at[1];
				this.addOwn(at, false);
			}
		} else if (e.type !== 'pointerleave') {
			// up, cancel or a lost capture: the stroke is kept either way, it fades by itself
			this.endStroke();
		}
	}

	addOwn(at, end) {
		const s = this.drawing?.s;
		if (!s) return; // cleared while drawing
		this.stroke('self', s, at ? at : [], end);
		this.outbox.stroke(s, at?.[0], at?.[1], end);
	}

	endStroke() {
		if (!this.drawing) return;
		this.addOwn(null, true);
		this.drawing = null;
	}

	destroy() {
		this.setMode(null);
		if (this.frame != null) cancelAnimationFrame(this.frame);
		clearTimeout(this.idleTimer);
		this.el.remove();
	}
}
