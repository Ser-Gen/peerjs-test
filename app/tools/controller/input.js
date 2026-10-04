import { CH } from '../../protocol.js';
import { Emitter } from '../../emitter.js';

/*
 * Input from a member's controller to a member that takes it (a host: the Monitor now, games later).
 * Buttons and axes follow the Standard Gamepad mapping, so an emulator can use them as they are:
 *   0 A (bottom)  1 B (right)  2 X (left)  3 Y (top)  4 LB  5 RB  6 LT  7 RT  8 Select  9 Start
 *   10 left stick  11 right stick  12 up  13 down  14 left  15 right  16 home
 *   axes: left stick x, y, right stick x, y, each −1…1 (y down)
 *
 * Protocol (ch: 'input'):
 *   host  {on}                           a member takes input now (or stopped); sent on every link up too
 *   state {slot, seq, t, buttons, down, axes, quat?, rtt?}
 *                                        controller → host over the fast channel (app/room.js: unordered, never
 *                                        resent), on every change at most 60 a second and again every 0.5 s.
 *                                        One that changes a button also goes over ctl, so a press is never lost.
 *                                        `slot` is the pad on the sending device: 0 its screen, 1–4 a gamepad
 *                                        plugged into it. `seq` counts up per slot; `down` holds the buttons that
 *                                        went down since the slot's previous message, so a tap whose fast message
 *                                        was lost is still counted when its ctl copy arrives after the release.
 *                                        `t` is the sender's clock, echoed back; `rtt` its last round trip.
 *   leave {slot}                         controller → host: that pad is gone
 *   echo  {slot, t}                      host → controller over the fast channel, once a second: the round trip
 */

export const BUTTONS = 17;
export const AXES = 4;
export const MAX_SLOTS = 5; // per device: its screen and four gamepads
export const BUTTON_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Select', 'Start', 'L3', 'R3', 'Up', 'Down', 'Left', 'Right', 'Home'];
export const INPUT_TIMING = {
	gap: 1000 / 60, // ms between two messages from one slot
	keep: 500, // a slot that doesn't change is sent again this often
	echo: 1000, // the host answers with an echo at most this often
	quiet: 3000, // a slot not heard from for this long shows as idle
};
const MASK = (1 << BUTTONS) - 1;

const clampAxis = v => (Number.isFinite(v) ? Math.round(Math.max(-1, Math.min(1, v)) * 1000) / 1000 : 0);
const isMask = v => Number.isInteger(v) && v >= 0 && v <= MASK;

/** A `state` message from a member, checked; null when it isn't one. Everything a member sends is untrusted. */
export function readState(msg) {
	if (!msg || typeof msg !== 'object') return null;
	const { slot, seq, t, buttons, down, axes, quat, rtt } = msg;
	if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SLOTS) return null;
	if (!Number.isSafeInteger(seq) || seq < 0 || !isMask(buttons) || !(down === undefined || isMask(down))) return null;
	if (!Array.isArray(axes) || axes.length > AXES || axes.some(a => typeof a !== 'number' || !Number.isFinite(a))) return null;
	let q = null;
	if (quat != null) {
		if (!Array.isArray(quat) || quat.length !== 4 || quat.some(v => typeof v !== 'number' || !Number.isFinite(v))) return null;
		const len = Math.hypot(...quat);
		if (len < 0.5 || len > 1.5) return null;
		q = quat.map(v => v / len);
	}
	return {
		slot,
		seq,
		t: typeof t === 'number' && Number.isFinite(t) ? t : null,
		buttons,
		down: down ?? 0,
		axes: Array.from({ length: AXES }, (_, i) => clampAxis(axes[i] ?? 0)),
		quat: q,
		rtt: typeof rtt === 'number' && Number.isFinite(rtt) && rtt >= 0 && rtt < 60000 ? Math.round(rtt) : null,
	};
}

// --- the controller's side ---

/**
 * What one device sends to one host: a slot each for its screen and its gamepads. `set(slot, state)` with the
 * slot's whole state ({buttons, axes, quat}); sending is paced here (on change, at most one per INPUT_TIMING.gap
 * per slot, again every INPUT_TIMING.keep), and a message that changes a button goes over ctl as well.
 */
export class InputSender {
	constructor(room, to) {
		this.room = room;
		this.to = to;
		this.slots = new Map(); // slot → {seq, buttons, axes, quat, sentButtons, down, last, timer, dirty}
		this.rtt = null;
		this.sent = 0;
		this.keeper = setInterval(() => this.keep(), INPUT_TIMING.keep);
	}

	set(slot, { buttons = 0, axes = [], quat = null } = {}) {
		let s = this.slots.get(slot);
		if (!s) {
			s = { seq: 0, buttons: 0, axes: [0, 0, 0, 0], quat: null, sentButtons: 0, down: 0, last: 0, timer: null };
			this.slots.set(slot, s);
		}
		const axesNow = Array.from({ length: AXES }, (_, i) => clampAxis(axes[i] ?? 0));
		const quatNow = quat ? quat.map(v => Math.round(v * 10000) / 10000) : null;
		const same = buttons === s.buttons && axesNow.every((a, i) => a === s.axes[i]) && String(quatNow) === String(s.quat);
		if (same && s.seq) return;
		s.down |= buttons & ~s.buttons; // pressed since the last message, even if already up again
		s.buttons = buttons & MASK;
		s.axes = axesNow;
		s.quat = quatNow;
		// A button change leaves at once; motion waits for its turn.
		const wait = s.buttons !== s.sentButtons || s.down ? 0 : s.last + INPUT_TIMING.gap - performance.now();
		if (wait <= 0) this.flush(slot);
		else s.timer ??= setTimeout(() => this.flush(slot), wait);
	}

	flush(slot) {
		const s = this.slots.get(slot);
		if (!s) return;
		clearTimeout(s.timer);
		s.timer = null;
		const edge = s.buttons !== s.sentButtons || s.down !== 0;
		const msg = { type: 'state', slot, seq: ++s.seq, t: Math.round(performance.now()), buttons: s.buttons, down: s.down, axes: s.axes };
		if (s.quat) msg.quat = s.quat;
		if (this.rtt != null) msg.rtt = this.rtt;
		s.down = 0;
		s.sentButtons = s.buttons;
		s.last = performance.now();
		this.room.sendFast(CH.INPUT, msg, this.to);
		if (edge) this.room.send(CH.INPUT, msg, this.to); // the same message on ctl, so a press arrives however late
		this.sent++;
	}

	keep() {
		const now = performance.now();
		for (const [slot, s] of this.slots) if (!s.timer && now - s.last >= INPUT_TIMING.keep - 5) this.flush(slot);
	}

	/** The host's echo of one of our `t`s. */
	onEcho(msg) {
		if (typeof msg?.t !== 'number' || !Number.isFinite(msg.t)) return;
		const rtt = performance.now() - msg.t;
		if (rtt >= 0 && rtt < 60000) this.rtt = Math.round(rtt);
	}

	leave(slot) {
		const s = this.slots.get(slot);
		if (!s) return;
		clearTimeout(s.timer);
		this.slots.delete(slot);
		this.room.send(CH.INPUT, { type: 'leave', slot }, this.to);
	}

	destroy() {
		clearInterval(this.keeper);
		for (const slot of [...this.slots.keys()]) this.leave(slot);
	}
}

// --- the host's side ---

const blankPad = () => ({ buttons: 0, axes: [0, 0, 0, 0], quat: null });

/**
 * Input that reaches this device, for whatever takes it: the Monitor, and games later. One per room (`InputHub.of`);
 * this device is announced as a host while anything holds it (`take()` → release function).
 *
 * Each pad a member sends gets a host slot, 0 and up, kept by its device and pad for as long as the hub lives, so
 * a member that reloads comes back to the same slot.
 *
 * Events: 'pads' (a pad came or went), 'state' (slot, pad) on every message that changed it, 'press' / 'release'
 * (slot, button), 'seats' (a game here says which player each pad is: `seats`, host slot → seat 0–3, or null). `getPad(slot)` is shaped like a Gamepad (buttons with pressed/value, axes, mapping 'standard'),
 * plus `orientation` (the quaternion, or null) and who it belongs to.
 */
export class InputHub extends Emitter {
	static #hubs = new WeakMap();

	static of(room) {
		let hub = InputHub.#hubs.get(room);
		if (!hub) InputHub.#hubs.set(room, (hub = new InputHub(room)));
		return hub;
	}

	constructor(room) {
		super();
		this.room = room;
		this.holders = 0;
		this.pads = new Map(); // host slot → pad
		this.slotOf = new Map(); // "<device ID>/<their slot>" → host slot
		this.seats = null; // host slot → seat, while a game runs here
		this.subs = [];
	}

	get hosting() {
		return this.holders > 0;
	}

	/** Take input: this device is announced as a host until the returned function is called. */
	take() {
		if (++this.holders === 1) this.start();
		let held = true;
		return () => {
			if (!held) return;
			held = false;
			if (--this.holders === 0) this.stop();
		};
	}

	start() {
		const room = this.room;
		this.subs = [
			room.on(`msg:${CH.INPUT}`, (msg, member) => this.onMessage(msg, member)),
			room.on('link-up', member => room.send(CH.INPUT, { type: 'host', on: true }, member.peerId)),
			room.on('link-down', member => this.dropMember(member.peerId)),
			room.on('members', () => this.rename()),
		];
		room.send(CH.INPUT, { type: 'host', on: true });
	}

	stop() {
		for (const off of this.subs.splice(0)) off();
		this.room.send(CH.INPUT, { type: 'host', on: false });
		for (const slot of [...this.pads.keys()]) this.remove(slot);
	}

	/** A game's players: host slot → seat (0–3), or null when no game runs. */
	setSeats(seats) {
		const same = (a, b) => a === b || (a && b && a.size === b.size && [...a].every(([k, v]) => b.get(k) === v));
		if (same(this.seats, seats)) return;
		this.seats = seats;
		this.emit('seats');
	}

	/** The pads in slot order. */
	list() {
		return [...this.pads.values()].sort((a, b) => a.index - b.index);
	}

	/** A snapshot shaped like a Gamepad; null for a slot nobody has. */
	getPad(slot) {
		const pad = this.pads.get(slot);
		if (!pad) return null;
		return {
			id: `${pad.name} (${pad.local ? `gamepad ${pad.local}` : 'screen'})`,
			index: pad.index,
			connected: true,
			mapping: 'standard',
			timestamp: pad.at,
			buttons: Array.from({ length: BUTTONS }, (_, i) => {
				const pressed = Boolean(pad.buttons & (1 << i));
				return { pressed, touched: pressed, value: pressed ? 1 : 0 };
			}),
			axes: [...pad.axes],
			orientation: pad.quat ? [...pad.quat] : null,
			peerId: pad.peerId,
			deviceId: pad.deviceId,
			name: pad.name,
			color: pad.color,
		};
	}

	onMessage(msg, member) {
		if (!member) return;
		if (msg?.type === 'leave') {
			if (Number.isInteger(msg.slot)) {
				const slot = this.slotOf.get(`${member.deviceId}/${msg.slot}`);
				const pad = this.pads.get(slot);
				if (pad?.peerId === member.peerId) this.remove(slot);
			}
			return;
		}
		if (msg?.type !== 'state') return;
		const state = readState(msg);
		if (state) this.apply(state, member);
	}

	padFor(member, local) {
		const key = `${member.deviceId}/${local}`;
		let slot = this.slotOf.get(key);
		if (slot === undefined) {
			const used = new Set(this.slotOf.values());
			slot = 0;
			while (used.has(slot)) slot++;
			this.slotOf.set(key, slot);
		}
		let pad = this.pads.get(slot);
		if (pad && pad.peerId !== member.peerId) {
			this.remove(slot); // the same device after a reload: a new peer ID starting over
			pad = null;
		}
		if (!pad) {
			pad = {
				index: slot,
				local,
				peerId: member.peerId,
				deviceId: member.deviceId,
				name: member.name,
				color: member.color,
				...blankPad(),
				seq: -1,
				pressSeq: new Array(BUTTONS).fill(-1),
				at: 0,
				rtt: null,
				echoAt: 0,
				packets: [], // arrival times in the last second
			};
			this.pads.set(slot, pad);
			this.emit('pads');
		}
		return pad;
	}

	apply(state, member) {
		const pad = this.padFor(member, state.slot);
		const slot = pad.index;
		const now = performance.now();
		pad.packets.push(now);
		while (pad.packets[0] < now - 1000) pad.packets.shift();
		// A press counts once, whichever copy of its message comes first; a late one after the release is a tap.
		const presses = [];
		for (let i = 0; i < BUTTONS; i++) {
			if (state.down & (1 << i) && pad.pressSeq[i] < state.seq) {
				pad.pressSeq[i] = state.seq;
				if (!(pad.buttons & (1 << i))) presses.push(i);
			}
		}
		const fresh = state.seq > pad.seq;
		const before = pad.buttons;
		if (fresh) {
			// Buttons down now that no `down` announced (its message lost, and this is newer) are presses too.
			for (let i = 0; i < BUTTONS; i++) {
				if (state.buttons & (1 << i) && !(before & (1 << i)) && !presses.includes(i)) {
					pad.pressSeq[i] = state.seq;
					presses.push(i);
				}
			}
			pad.seq = state.seq;
			pad.buttons = state.buttons;
			pad.axes = state.axes;
			pad.quat = state.quat;
			pad.at = now;
			if (state.rtt != null) pad.rtt = state.rtt;
		}
		for (const i of presses) this.emit('press', slot, i);
		if (!fresh) {
			// A stale copy: a tap whose release is already here comes and goes at once.
			for (const i of presses) if (!(pad.buttons & (1 << i))) this.emit('release', slot, i);
		}
		for (let i = 0; i < BUTTONS; i++) if (fresh && before & (1 << i) && !(pad.buttons & (1 << i))) this.emit('release', slot, i);
		if (fresh || presses.length) this.emit('state', slot, this.getPad(slot));
		if (state.t != null && now - pad.echoAt >= INPUT_TIMING.echo) {
			pad.echoAt = now;
			this.room.sendFast(CH.INPUT, { type: 'echo', slot: state.slot, t: state.t }, member.peerId);
		}
	}

	/** Messages in the last second, for a packets-per-second figure. */
	rate(slot) {
		const pad = this.pads.get(slot);
		if (!pad) return 0;
		const now = performance.now();
		while (pad.packets.length && pad.packets[0] < now - 1000) pad.packets.shift();
		return pad.packets.length;
	}

	remove(slot) {
		const pad = this.pads.get(slot);
		if (!pad) return;
		this.pads.delete(slot);
		for (let i = 0; i < BUTTONS; i++) if (pad.buttons & (1 << i)) this.emit('release', slot, i);
		this.emit('pads');
	}

	dropMember(peerId) {
		for (const [slot, pad] of [...this.pads]) if (pad.peerId === peerId) this.remove(slot);
	}

	rename() {
		let changed = false;
		for (const pad of this.pads.values()) {
			const member = this.room.member(pad.peerId);
			if (member && (member.name !== pad.name || member.color !== pad.color)) {
				pad.name = member.name;
				pad.color = member.color;
				changed = true;
			}
		}
		if (changed) this.emit('pads');
	}
}

/** Who in the room takes input now: peer ID → true, from their `host` messages. */
export class HostList extends Emitter {
	constructor(room) {
		super();
		this.room = room;
		this.hosts = new Set();
		this.subs = [
			room.on(`msg:${CH.INPUT}`, (msg, member) => {
				if (msg?.type !== 'host' || !member) return;
				const had = this.hosts.has(member.peerId);
				if (msg.on === true) this.hosts.add(member.peerId);
				else this.hosts.delete(member.peerId);
				if (had !== this.hosts.has(member.peerId)) this.emit('change');
			}),
			room.on('link-down', member => {
				if (this.hosts.delete(member.peerId)) this.emit('change');
			}),
			room.on('members', () => this.emit('change')),
		];
	}

	/** The hosts that are members now, in the room's order. */
	list() {
		return this.room.members.filter(member => this.hosts.has(member.peerId));
	}

	destroy() {
		for (const off of this.subs.splice(0)) off();
	}
}
