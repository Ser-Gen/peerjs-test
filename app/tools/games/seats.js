import { Emitter } from '../../emitter.js';

/*
 * Who plays which player of a game. A seat holds a source, or nobody:
 *   'host'     this device: its keys, its screen and its first gamepad (only for a game this device plays too)
 *   'gp:<n>'   another gamepad plugged into this device (index n ≥ 1)
 *   'pad:<n>'  a member's pad, by its InputHub slot (kept by device, so a reload comes back to the same seat)
 */

export const MAX_PLAYERS = 4;

export const isSource = s => s === 'host' || /^(gp|pad):\d{1,2}$/.test(s);

/**
 * The seats of one game. A source seen for the first time takes the first free seat (with `host`, this device is
 * Player 1); one moved off its seat by hand stays off when it comes back. 'change' when a seat changes.
 */
export class Seats extends Emitter {
	constructor(count = MAX_PLAYERS, { host = true } = {}) {
		super();
		this.seats = new Array(Math.max(1, Math.min(MAX_PLAYERS, count))).fill(null);
		this.known = new Set();
		if (host) this.arrive('host');
	}

	seatOf(source) {
		return this.seats.indexOf(source);
	}

	/** A source is here: seated if it's new and a seat is free. Returns its seat, or −1. */
	arrive(source) {
		if (this.known.has(source)) return this.seatOf(source);
		this.known.add(source);
		const free = this.seats.indexOf(null);
		if (free === -1) return -1;
		this.seats[free] = source;
		this.emit('change');
		return free;
	}

	/** Put a source (or nobody) on a seat; a source on another seat swaps with whoever was here. */
	assign(seat, source) {
		if (!Number.isInteger(seat) || seat < 0 || seat >= this.seats.length) return;
		if (source !== null && !isSource(source)) return;
		const was = this.seats[seat];
		if (was === source) return;
		if (source !== null) {
			this.known.add(source);
			const from = this.seatOf(source);
			if (from !== -1) this.seats[from] = was;
		}
		this.seats[seat] = source;
		this.emit('change');
	}
}
