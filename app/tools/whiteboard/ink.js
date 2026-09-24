// Stroke geometry for the whiteboard: points packed for the board document, simplification, bounds and hit tests.
// A stroke's points are a flat list [x, y, pressure, x, y, pressure, …] in board units (CSS pixels at zoom 1).

export const MAX_POINTS = 4000; // raw points in one stroke; a longer one goes on as a new stroke
const POINT_BYTES = 12; // three little-endian float32s
const MAX_COORD = 1e7;

/** Pack [x, y, p, …] into bytes for the board document (Yjs stores a Uint8Array as is). */
export function packPoints(points) {
	const count = Math.floor(points.length / 3);
	const bytes = new Uint8Array(count * POINT_BYTES);
	const view = new DataView(bytes.buffer);
	for (let i = 0; i < count * 3; i++) view.setFloat32(i * 4, points[i], true);
	return bytes;
}

const unpacked = new WeakMap(); // the bytes in the document never change, so each is read once

/** The points of packed bytes from the document, or null if they aren't a valid stroke. */
export function unpackPoints(bytes) {
	if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length % POINT_BYTES || bytes.length > MAX_POINTS * POINT_BYTES) return null;
	if (unpacked.has(bytes)) return unpacked.get(bytes);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const points = new Float32Array(bytes.length / 4);
	let ok = true;
	for (let i = 0; i < points.length; i++) {
		const value = view.getFloat32(i * 4, true);
		const pressure = i % 3 === 2;
		if (!Number.isFinite(value) || (pressure ? value < 0 || value > 1 : Math.abs(value) > MAX_COORD)) {
			ok = false;
			break;
		}
		points[i] = value;
	}
	const result = ok ? points : null;
	unpacked.set(bytes, result);
	return result;
}

/**
 * Ramer–Douglas–Peucker: drop the points that lie within `tolerance` of the line through their neighbours and
 * whose pressure is within `pressureTolerance` of what the neighbours' pressures give there, so a stylus
 * stroke keeps where it was pressed harder. The first and last points always stay.
 */
export function simplify(points, tolerance, pressureTolerance = 0.05) {
	const count = Math.floor(points.length / 3);
	if (count <= 2) return Array.from(points);
	const keep = new Uint8Array(count);
	keep[0] = keep[count - 1] = 1;
	const stack = [[0, count - 1]];
	const limit = tolerance * tolerance;
	while (stack.length) {
		const [first, last] = stack.pop();
		const [fx, fy, fp] = [points[first * 3], points[first * 3 + 1], points[first * 3 + 2]];
		const [lx, ly, lp] = [points[last * 3], points[last * 3 + 1], points[last * 3 + 2]];
		let worst = -1;
		let worstScore = 1; // above 1: out of tolerance
		for (let i = first + 1; i < last; i++) {
			const off = Math.abs(points[i * 3 + 2] - (fp + ((lp - fp) * (i - first)) / (last - first)));
			const score = Math.max(segmentDistance2(points[i * 3], points[i * 3 + 1], fx, fy, lx, ly) / limit, off / pressureTolerance);
			if (score > worstScore) {
				worst = i;
				worstScore = score;
			}
		}
		if (worst !== -1) {
			keep[worst] = 1;
			stack.push([first, worst], [worst, last]);
		}
	}
	const out = [];
	for (let i = 0; i < count; i++) if (keep[i]) out.push(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
	return out;
}

/** Squared distance from (px, py) to the segment a–b. */
export function segmentDistance2(px, py, ax, ay, bx, by) {
	const dx = bx - ax;
	const dy = by - ay;
	const length2 = dx * dx + dy * dy;
	let t = length2 ? ((px - ax) * dx + (py - ay) * dy) / length2 : 0;
	t = Math.max(0, Math.min(1, t));
	const x = ax + t * dx - px;
	const y = ay + t * dy - py;
	return x * x + y * y;
}

/** How wide a pen is at a pressure: 0.5, the pressure of a mouse or a finger, is the chosen size. */
export const widthAt = (size, pressure) => size * (0.3 + 1.4 * pressure);

/** Whether every point has the same pressure (a mouse or a finger): such a stroke is drawn as one smooth path. */
export function evenPressure(points) {
	for (let i = 5; i < points.length; i += 3) if (points[i] !== points[2]) return false;
	return true;
}

const boxes = new WeakMap();

/** The box around the points' centres (without the stroke's width). */
export function pointBounds(points) {
	if (boxes.has(points)) return boxes.get(points);
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (let i = 0; i < points.length; i += 3) {
		minX = Math.min(minX, points[i]);
		maxX = Math.max(maxX, points[i]);
		minY = Math.min(minY, points[i + 1]);
		maxY = Math.max(maxY, points[i + 1]);
	}
	const box = { minX, minY, maxX, maxY };
	if (typeof points === 'object' && !Array.isArray(points)) boxes.set(points, box);
	return box;
}

/** The box an item covers on the board, its width included. */
export function itemBounds(item) {
	if (item.kind === 'image') return { minX: item.x, minY: item.y, maxX: item.x + item.w, maxY: item.y + item.h };
	const box = pointBounds(item.points);
	const pad = (item.kind === 'pen' ? widthAt(item.size, 1) : item.size) / 2;
	return { minX: box.minX + item.x - pad, minY: box.minY + item.y - pad, maxX: box.maxX + item.x + pad, maxY: box.maxY + item.y + pad };
}

export const overlaps = (a, b) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

/** Whether a circle at (x, y) with `radius` touches the item. */
export function hits(item, x, y, radius) {
	const box = itemBounds(item);
	if (x < box.minX - radius || x > box.maxX + radius || y < box.minY - radius || y > box.maxY + radius) return false;
	if (item.kind === 'image') return true;
	const { points } = item;
	const px = x - item.x;
	const py = y - item.y;
	const half = item.kind === 'pen' ? null : item.size / 2;
	if (points.length === 3) {
		const reach = radius + (half ?? widthAt(item.size, points[2]) / 2);
		return (points[0] - px) ** 2 + (points[1] - py) ** 2 <= reach * reach;
	}
	for (let i = 3; i < points.length; i += 3) {
		const reach = radius + (half ?? widthAt(item.size, Math.max(points[i - 1], points[i + 2])) / 2);
		if (segmentDistance2(px, py, points[i - 3], points[i - 2], points[i], points[i + 1]) <= reach * reach) return true;
	}
	return false;
}

/** The union of boxes, or null for none. */
export function unionBounds(boxList) {
	let out = null;
	for (const box of boxList) {
		out = out
			? { minX: Math.min(out.minX, box.minX), minY: Math.min(out.minY, box.minY), maxX: Math.max(out.maxX, box.maxX), maxY: Math.max(out.maxY, box.maxY) }
			: { ...box };
	}
	return out;
}
