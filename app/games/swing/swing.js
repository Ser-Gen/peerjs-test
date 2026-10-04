import { conjugate, multiply } from '../../tools/controller/motion.js';

/*
 * Swings from a phone's orientation (the Controller's Motion pad: a quaternion in the frame the phone had at its
 * last Recenter, held in landscape facing you). The turn between two readings over the time between them is the
 * angular velocity; a swing starts when that goes past SWING.start and ends when it drops under SWING.end, and is
 * read as its peak speed and the way it turned the most:
 *   about the screen's up axis (y)       left (+) or right (−)
 *   about the screen's right axis (x)    up (+) or down (−)
 *   about the axis out of the screen (z) a twist
 */

const DEG = 180 / Math.PI;
export const SWING = {
	start: 180, // °/s: a swing starts above this
	end: 90, // °/s: and ends below this
	soft: 400, // °/s: a peak under this is soft
	hard: 800, // °/s: and from this on hard
	minTurn: 20, // ° a swing must turn in all, so a jolt isn't one
	longest: 1500, // ms: a swing that goes on longer ends here
	gap: 250, // ms: readings further apart than this aren't compared
};

/** The angular velocity (°/s, in the reference frame) that turns q0 into q1 in `dt` ms. */
export function angularVelocity(q0, q1, dt) {
	let d = multiply(q1, conjugate(q0));
	if (d[3] < 0) d = d.map(v => -v); // the shorter way round
	const s = Math.hypot(d[0], d[1], d[2]);
	if (!s || !(dt > 0)) return [0, 0, 0];
	const angle = 2 * Math.atan2(s, d[3]) * DEG; // degrees
	const k = angle / s / (dt / 1000);
	return [d[0] * k, d[1] * k, d[2] * k];
}

export const strength = speed => (speed >= SWING.hard ? 'Hard' : speed >= SWING.soft ? 'Medium' : 'Soft');

/** The way a swing turned the most, from its whole turn (a rotation vector in degrees). */
export function direction([x, y, z]) {
	const ax = Math.abs(x);
	const ay = Math.abs(y);
	const az = Math.abs(z);
	if (ay >= ax && ay >= az) return y > 0 ? 'left' : 'right';
	if (ax >= az) return x > 0 ? 'up' : 'down';
	return 'twist';
}

/** One player's swings. `update(quat, t)` with every reading (t in ms); it returns a swing when one ends. */
export class SwingMeter {
	constructor() {
		this.reset();
		this.prev = null;
		this.speed = 0; // °/s now
		this.swing = null; // the swing going on: {peak, turn, start, last}
	}

	/** Forget the results (not the reading in progress). */
	reset() {
		this.last = null; // the last swing: {speed, strength, direction, turn}
		this.best = null;
		this.count = 0;
	}

	update(quat, t) {
		if (!quat || !Number.isFinite(t)) return null;
		const prev = this.prev;
		this.prev = { quat, t };
		if (!prev || t <= prev.t) return null;
		const dt = t - prev.t;
		if (dt > SWING.gap) {
			this.speed = 0;
			return this.end();
		}
		const w = angularVelocity(prev.quat, quat, dt);
		const speed = Math.hypot(...w);
		this.speed = speed;
		if (!this.swing) {
			if (speed < SWING.start) return null;
			this.swing = { peak: 0, turn: [0, 0, 0], start: prev.t };
		}
		const swing = this.swing;
		swing.peak = Math.max(swing.peak, speed);
		swing.turn = swing.turn.map((v, i) => v + w[i] * dt / 1000);
		if (speed < SWING.end || t - swing.start > SWING.longest) return this.end();
		return null;
	}

	/** No reading for SWING.gap: the phone stopped (a still phone sends only now and then). Returns a swing that ended. */
	idle() {
		this.speed = 0;
		return this.end();
	}

	/** The swing going on is over: counted if it turned far enough. */
	end() {
		const swing = this.swing;
		this.swing = null;
		if (!swing || Math.hypot(...swing.turn) < SWING.minTurn) return null;
		const result = { speed: Math.round(swing.peak), strength: strength(swing.peak), direction: direction(swing.turn), turn: Math.round(Math.hypot(...swing.turn)) };
		this.last = result;
		if (!this.best || result.speed > this.best.speed) this.best = result;
		this.count++;
		return result;
	}
}
