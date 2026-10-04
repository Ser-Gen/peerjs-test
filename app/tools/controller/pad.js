import { CH } from '../../protocol.js';
import { button, h, icon, toast } from '../../ui/dom.js';
import { wakeLock } from '../../util.js';
import { BUTTONS, InputSender } from './input.js';
import { Motion } from './motion.js';

export const LAYOUTS = { nes: 'NES pad', motion: 'Motion' };
export const MAX_GAMEPADS = 4; // slots 1–4
const SLOP = 14; // px around a button that still counts as on it, for thumbs
const DPAD_DEAD = 0.2; // of the D-pad's radius: the middle presses nothing
const B = { SOUTH: 0, EAST: 1, RT: 7, SELECT: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const bit = i => 1 << i;

/** Gamepads plugged into this device that get a slot (1–4). */
export const localGamepads = () => [...(navigator.getGamepads?.() ?? [])].filter(Boolean).filter(gp => gp.index < MAX_GAMEPADS);

/*
 * The full-screen pad: this device as a controller for one host, until stop(). Used by the Controller tool, and by
 * the Games tool's guests (in the layout the game asks for; with the game's picture behind the buttons in Remote play).
 *
 * NES pad: a D-pad, Select, Start, B and A (Standard Gamepad 12–15, 8, 9, 0 and 1: NES B is the bottom button,
 * A the right one). Motion: one big trigger (7) and the phone's orientation. Both full screen, landscape, with the
 * screen kept on and a short vibration on each press. Gamepads plugged into the phone go along as slots 1–4.
 *
 * It stops by itself when the host's link goes down or Back leaves full screen; `onStop` is called whichever way it
 * ends. Whoever started it stops it when the host stops taking input.
 *
 * With a `sink` it is this device's own pad (the NES host playing on its own screen): the state goes to the sink
 * instead of a member, and it sits in `container` (over the game's picture) instead of covering the page.
 */
export class PadPlay {
	/**
	 * @param {object} room
	 * @param {object} host the member that takes the input
	 * @param {object} [options]
	 * @param {'nes'|'motion'} [options.layout]
	 * @param {Element} [options.background] shown behind the buttons (the game's picture)
	 * @param {(state: {buttons: number, axes: number[], quat: number[]|null}) => void} [options.sink] a pad of this device
	 * @param {Element} [options.container] where the pad goes and what goes full screen (default: the whole page)
	 * @param {boolean} [options.gamepads] send gamepads plugged in here along (not for a sink: the host reads its own)
	 * @param {Element[]} [options.actions] more buttons for the top bar
	 * @param {() => void} [options.onStop]
	 */
	constructor(room, host, { layout = 'nes', background = null, sink = null, container = null, gamepads = !sink, actions = [], onStop = () => {} } = {}) {
		this.room = room;
		this.host = host.peerId;
		this.layout = layout;
		this.onStop = onStop;
		this.container = container;
		this.withGamepads = gamepads;
		this.sender = sink ? new LocalSender(sink) : new InputSender(room, host.peerId);
		this.zones = [];
		this.pointers = new Map();
		this.buttons = 0;
		this.motion = null;
		this.quat = null;
		this.full = false;
		this.frame = 0;
		this.gamepads = new Set();
		this.stopped = false;

		this.surface = h('div', { class: 'pad-surface', 'data-layout': layout });
		this.hostName = h('span', { class: 'pad-host', style: `--member: ${host.color}` }, host.name);
		this.latency = h('span', { class: 'pad-latency' });
		const stopBtn = h('button', { type: 'button', class: 'pad-top-btn', 'aria-label': 'Stop', title: 'Stop', onclick: () => this.stop() }, icon('close'));
		this.top = h('div', { class: 'pad-top' }, this.hostName, this.latency, ...actions, stopBtn);
		this.el = h('div', { class: `pad-play${background || container ? ' over-picture' : ''}${container ? ' inline' : ''}` }, ...(background ? [h('div', { class: 'pad-picture' }, background)] : []), this.top, this.surface);
		if (layout === 'nes') this.buildNes();
		else this.buildMotion();
		this.surface.addEventListener('pointerdown', e => this.onPointer(e));
		this.surface.addEventListener('pointermove', e => this.onPointer(e));
		for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) this.surface.addEventListener(type, e => this.onPointerEnd(e));
		this.surface.addEventListener('contextmenu', e => e.preventDefault()); // a long press is a held button

		this.subs = [
			room.on(`msg:${CH.INPUT}`, (msg, member) => {
				if (msg?.type === 'echo' && member?.peerId === this.host) this.sender.onEcho(msg);
			}),
			room.on('link-down', member => {
				if (member.peerId !== this.host) return;
				toast(`${member.name} left: the controller stopped`);
				this.stop();
			}),
		];
		this.onFullscreen = () => {
			if (this.full && !document.fullscreenElement) this.stop(); // Back left full screen
		};
		document.addEventListener('fullscreenchange', this.onFullscreen);
		this.statsTimer = setInterval(() => {
			const rtt = this.sender.rtt;
			this.latency.textContent = rtt == null ? '' : `${Math.max(1, Math.round(rtt / 2))} ms`;
		}, 250);

		(container ?? document.body).append(this.el);
		wakeLock.acquire();
		this.sender.set(0, { buttons: 0 }); // the host shows the pad at once
		this.pollGamepads();
		this.goFull();
	}

	async goFull() {
		const target = this.container ?? document.documentElement;
		try {
			await target.requestFullscreen?.({ navigationUI: 'hide' });
			this.full = document.fullscreenElement === target;
			await screen.orientation?.lock?.('landscape');
		} catch {
			// Not allowed here (a desktop browser, or iOS): the pad works in the page as it is.
		}
	}

	setHostName(name) {
		this.hostName.textContent = name;
	}

	buildNes() {
		const zone = (index, label, cls) => {
			const el = h('div', { class: `pad-btn ${cls}`, 'data-button': index, 'aria-label': label }, label);
			this.zones.push({ el, bits: () => bit(index) });
			return el;
		};
		const dpad = h('div', { class: 'pad-dpad', 'aria-label': 'D-pad' },
			...['up', 'down', 'left', 'right'].map(dir => h('span', { class: `pad-arrow ${dir}` })));
		this.zones.push({ el: dpad, dpad: true });
		this.surface.append(
			h('div', { class: 'pad-left' }, dpad),
			h('div', { class: 'pad-middle' }, zone(B.SELECT, 'Select', 'small'), zone(B.START, 'Start', 'small')),
			h('div', { class: 'pad-right' }, zone(B.SOUTH, 'B', 'round b'), zone(B.EAST, 'A', 'round a')));
	}

	buildMotion() {
		const trigger = h('div', { class: 'pad-btn trigger', 'data-button': B.RT, 'aria-label': 'Trigger' }, 'Trigger');
		this.zones.push({ el: trigger, bits: () => bit(B.RT) });
		const status = h('p', { class: 'pad-motion-status' }, 'Starting motion…');
		this.top.insertBefore(button('Recenter', 'fit', () => this.motion?.recenter(), 'pad-top-btn text'), this.top.lastChild);
		this.surface.append(h('div', { class: 'pad-motion' }, trigger, status));
		this.motion = new Motion(quat => {
			this.quat = quat;
			this.sendPad();
		});
		this.motion.start().then(source => {
			if (this.stopped) return;
			status.textContent = source ? 'Tilt and turn the phone; Recenter makes the way it points now straight ahead.'
				: 'This device gives no orientation: only the trigger is sent.';
		});
	}

	/** Which buttons a point presses: the zone under it, or the nearest one within SLOP. */
	hit(x, y) {
		let best = null;
		let bestDist = SLOP;
		for (const zone of this.zones) {
			const r = zone.el.getBoundingClientRect();
			if (zone.dpad) {
				const cx = r.left + r.width / 2;
				const cy = r.top + r.height / 2;
				const radius = Math.min(r.width, r.height) / 2;
				const dx = x - cx;
				const dy = y - cy;
				const d = Math.hypot(dx, dy);
				if (!radius || d > radius + SLOP || d < radius * DPAD_DEAD) continue;
				// Eight directions: each 45° sector around an axis presses one arrow, between two it presses both.
				const sector = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
				const bits = [bit(B.RIGHT), bit(B.RIGHT) | bit(B.DOWN), bit(B.DOWN), bit(B.DOWN) | bit(B.LEFT), bit(B.LEFT),
					bit(B.LEFT) | bit(B.UP), bit(B.UP), bit(B.UP) | bit(B.RIGHT)][(sector + 8) % 8];
				return bits;
			}
			const dx = Math.max(r.left - x, 0, x - r.right);
			const dy = Math.max(r.top - y, 0, y - r.bottom);
			const d = Math.hypot(dx, dy);
			if (d === 0) return zone.bits();
			if (d < bestDist) {
				bestDist = d;
				best = zone;
			}
		}
		return best ? best.bits() : 0;
	}

	onPointer(e) {
		if (this.stopped) return;
		if (e.type === 'pointerdown') {
			e.preventDefault();
			try {
				this.surface.setPointerCapture(e.pointerId);
			} catch {
				// a pointer that is already gone
			}
		} else if (!this.pointers.has(e.pointerId)) return; // a hovering mouse
		this.pointers.set(e.pointerId, this.hit(e.clientX, e.clientY));
		this.sendPad();
	}

	onPointerEnd(e) {
		if (!this.pointers.delete(e.pointerId)) return;
		this.sendPad();
	}

	sendPad() {
		if (this.stopped) return;
		let buttons = 0;
		for (const bits of this.pointers.values()) buttons |= bits;
		const pressed = buttons & ~this.buttons;
		if (pressed) navigator.vibrate?.(12);
		this.buttons = buttons;
		for (const zone of this.zones) {
			const on = zone.dpad ? (buttons & (bit(B.UP) | bit(B.DOWN) | bit(B.LEFT) | bit(B.RIGHT))) !== 0 : (buttons & zone.bits()) !== 0;
			zone.el.classList.toggle('on', on);
			if (zone.dpad) for (const [dir, i] of [['up', B.UP], ['down', B.DOWN], ['left', B.LEFT], ['right', B.RIGHT]]) {
				zone.el.querySelector(`.${dir}`).classList.toggle('on', (buttons & bit(i)) !== 0);
			}
		}
		this.sender.set(0, { buttons, quat: this.quat });
	}

	/** Gamepads plugged into this device, read every frame while playing (the Gamepad API has no events for input). */
	pollGamepads() {
		if (this.stopped || !this.withGamepads) return;
		const seen = new Set();
		for (const gp of localGamepads()) {
			const slot = gp.index + 1;
			seen.add(slot);
			let buttons = 0;
			gp.buttons.slice(0, BUTTONS).forEach((b, i) => {
				if (b?.pressed) buttons |= bit(i);
			});
			this.sender.set(slot, { buttons, axes: [...gp.axes].slice(0, 4) });
		}
		for (const slot of this.gamepads) if (!seen.has(slot)) this.sender.leave(slot);
		this.gamepads = seen;
		this.frame = requestAnimationFrame(() => this.pollGamepads());
	}

	stop() {
		if (this.stopped) return;
		this.stopped = true;
		cancelAnimationFrame(this.frame);
		clearInterval(this.statsTimer);
		for (const off of this.subs) off();
		document.removeEventListener('fullscreenchange', this.onFullscreen);
		this.motion?.stop();
		this.sender.destroy();
		this.el.remove();
		wakeLock.release();
		try {
			screen.orientation?.unlock?.();
		} catch {
			// never locked
		}
		if (this.full && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
		this.onStop();
	}
}

/** A pad of this device: the screen pad's state (slot 0) goes to a function instead of a member. */
class LocalSender {
	constructor(sink) {
		this.sink = sink;
		this.rtt = null;
	}

	set(slot, state) {
		if (slot === 0) this.sink({ buttons: state.buttons ?? 0, axes: state.axes ?? [], quat: state.quat ?? null });
	}

	leave() {}

	onEcho() {}

	destroy() {
		this.sink({ buttons: 0, axes: [], quat: null });
	}
}
