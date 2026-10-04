import { Emitter } from '../../emitter.js';
import { NES_BUTTONS, PADS } from './emulator.js';

/*
 * Who plays which NES pad, and how each kind of input becomes NES buttons (bits in NES_BUTTONS' order:
 * A, B, Select, Start, Up, Down, Left, Right).
 *
 * Sources:
 *   'host'     this device: its keyboard and its first gamepad
 *   'gp:<n>'   another gamepad plugged into this device (index n ≥ 1)
 *   'pad:<n>'  a member's pad, by its InputHub slot (kept by device, so a reload comes back to the same seat)
 */

const bit = i => 1 << i;
export const NES = Object.fromEntries(NES_BUTTONS.map((name, i) => [name, bit(i)]));
const STICK = 0.5; // a stick pushed this far is a D-pad direction

/** Standard Gamepad buttons (a mask) and axes as NES buttons. NES B is the bottom face button, A the right one. */
export function nesBits(buttons, axes = []) {
	let b = 0;
	if (buttons & (bit(1) | bit(3))) b |= NES.A;
	if (buttons & (bit(0) | bit(2))) b |= NES.B;
	if (buttons & bit(8)) b |= NES.Select;
	if (buttons & bit(9)) b |= NES.Start;
	if (buttons & bit(12) || axes[1] < -STICK) b |= NES.Up;
	if (buttons & bit(13) || axes[1] > STICK) b |= NES.Down;
	if (buttons & bit(14) || axes[0] < -STICK) b |= NES.Left;
	if (buttons & bit(15) || axes[0] > STICK) b |= NES.Right;
	return b;
}

/** A Gamepad from the Gamepad API as NES buttons. */
export function gamepadBits(gp) {
	if (!gp) return 0;
	let buttons = 0;
	gp.buttons.slice(0, 17).forEach((b, i) => {
		if (b?.pressed) buttons |= bit(i);
	});
	return nesBits(buttons, [...gp.axes]);
}

/** Keys by KeyboardEvent.code, so they stay put on any keyboard layout. */
export const DEFAULT_KEYS = {
	A: 'KeyX', B: 'KeyZ', Select: 'ShiftRight', Start: 'Enter', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
};

/** A key map read from storage: every button a short code, else the default. */
export function readKeys(raw) {
	const keys = { ...DEFAULT_KEYS };
	if (raw && typeof raw === 'object') {
		for (const name of NES_BUTTONS) {
			const code = raw[name];
			if (typeof code === 'string' && /^[A-Za-z0-9]{1,24}$/.test(code)) keys[name] = code;
		}
	}
	return keys;
}

/** A key's name for people: "X", "Enter", "←". */
export function keyLabel(code) {
	const arrows = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
	if (arrows[code]) return arrows[code];
	if (/^Key[A-Z]$/.test(code)) return code.slice(3);
	if (/^Digit\d$/.test(code)) return code.slice(5);
	return code.replace(/(Left|Right)$/, ' ($1)').replace(/^Numpad/, 'Num ');
}

export const isSource = s => s === 'host' || /^(gp|pad):\d{1,2}$/.test(s);

/**
 * Four seats. A source seen for the first time takes the first free seat (this device's keyboard is Player 1);
 * one moved off its seat by hand stays off when it comes back. 'change' when a seat changes.
 */
export class Seats extends Emitter {
	constructor() {
		super();
		this.seats = new Array(PADS).fill(null);
		this.known = new Set();
		this.arrive('host');
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
		if (seat < 0 || seat >= PADS) return;
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
