import { NES_BUTTONS } from './emulator.js';

/*
 * How each kind of input becomes NES buttons (bits in NES_BUTTONS' order: A, B, Select, Start, Up, Down, Left,
 * Right), and the keys. Who sits on which pad is the Games tool's (app/tools/games/seats.js).
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
