import { CH } from '../../protocol.js';
import { button, h, icon, toast } from '../../ui/dom.js';
import { readJSON, wakeLock, writeJSON } from '../../util.js';
import { BUTTONS, BUTTON_NAMES, HostList, INPUT_TIMING, InputHub, InputSender } from './input.js';
import { Motion } from './motion.js';

const PREFS_KEY = 'peerkit.controller';
const PREFS_VERSION = 1;
const MODES = ['pad', 'monitor'];
const LAYOUTS = { nes: 'NES pad', motion: 'Motion' };
const MAX_GAMEPADS = 4; // slots 1–4
const SLOP = 14; // px around a button that still counts as on it, for thumbs
const DPAD_DEAD = 0.2; // of the D-pad's radius: the middle presses nothing
const B = { SOUTH: 0, EAST: 1, RT: 7, SELECT: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const bit = i => 1 << i;

/*
 * The Controller tool: this device as a game pad for another member (Controller), or the input that reaches it
 * (Monitor). Messages and pacing are in input.js; the Monitor holds the room's InputHub, which is what makes this
 * device a host that controllers can choose.
 *
 * NES pad: a D-pad, Select, Start, B and A (Standard Gamepad 12–15, 8, 9, 0 and 1: NES B is the bottom button,
 * A the right one). Motion: one big trigger (7) and the phone's orientation. Both full screen, landscape, with the
 * screen kept on and a short vibration on each press. Gamepads plugged into the phone go along as slots 1–4.
 */

export default {
	id: 'controller',
	title: 'Controller',
	supported: () => typeof RTCPeerConnection === 'function',
	mount(el, room, ctx) {
		const tool = new ControllerTool(el, room, ctx);
		return () => tool.destroy();
	},
};

const coarse = () => matchMedia('(pointer: coarse)').matches;

function loadPrefs() {
	const raw = readJSON(PREFS_KEY);
	const ok = raw?.version === PREFS_VERSION;
	return {
		mode: ok && MODES.includes(raw.mode) ? raw.mode : coarse() ? 'pad' : 'monitor',
		layout: ok && Object.hasOwn(LAYOUTS, raw.layout) ? raw.layout : 'nes',
		host: ok && typeof raw.host === 'string' && raw.host.length <= 64 ? raw.host : null, // a device ID
	};
}

/** The rotation of a quaternion (device frame: x right, y up, z out of the screen) as a CSS matrix3d. */
export function cssRotation(q) {
	const [x, y, z, w] = q;
	const m = [
		1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
		2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
		2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
	];
	// CSS has y down: flip y on both sides (S·M·S with S = diag(1, −1, 1)).
	const s = [1, -1, 1];
	const r = (i, j) => (s[i] * m[i * 3 + j] * s[j]).toFixed(4);
	return `matrix3d(${r(0, 0)},${r(1, 0)},${r(2, 0)},0,${r(0, 1)},${r(1, 1)},${r(2, 1)},0,${r(0, 2)},${r(1, 2)},${r(2, 2)},0,0,0,0,1)`;
}

class ControllerTool {
	constructor(el, room, ctx) {
		this.el = el;
		this.room = room;
		this.ctx = ctx;
		this.prefs = loadPrefs();
		this.hosts = new HostList(room);
		this.hub = InputHub.of(room);
		this.release = null; // the hub, while the Monitor is chosen
		this.play = null; // the full-screen pad while playing
		this.cards = new Map(); // host slot → the Monitor's card
		this.dirty = new Set();
		this.frame = 0;
		this.subs = [
			this.hosts.on('change', () => this.onHosts()),
			this.hub.on('pads', () => this.renderPads()),
			this.hub.on('state', slot => this.markDirty(slot)),
			room.on(`msg:${CH.INPUT}`, (msg, member) => {
				if (msg?.type === 'echo' && this.play?.host === member?.peerId) this.play.sender.onEcho(msg);
			}),
			room.on('link-down', member => {
				if (this.play?.host === member.peerId) {
					toast(`${member.name} left: the controller stopped`);
					this.stop();
				}
			}),
		];
		this.statsTimer = setInterval(() => this.renderStats(), 250);
		this.onGamepads = () => this.renderGamepads();
		window.addEventListener('gamepadconnected', this.onGamepads);
		window.addEventListener('gamepaddisconnected', this.onGamepads);
		this.onFullscreen = () => {
			if (this.play?.full && !document.fullscreenElement) this.stop(); // Back left full screen
		};
		document.addEventListener('fullscreenchange', this.onFullscreen);

		el.classList.add('controller');
		this.modeBar = h('div', { class: 'segmented controller-modes', role: 'group', 'aria-label': 'Use this device as' },
			...MODES.map(mode => h('button', { type: 'button', class: 'segment', 'data-mode': mode, onclick: () => this.setMode(mode) },
				mode === 'pad' ? 'Controller' : 'Monitor')));
		this.padView = this.buildSetup();
		this.monitorView = h('div', { class: 'monitor' },
			(this.monitorEmpty = h('p', { class: 'hint monitor-empty' }, 'No controllers yet. On a phone in this room, open Controller and choose Start.')),
			(this.monitorList = h('div', { class: 'monitor-pads' })));
		el.append(h('div', { class: 'controller-body' }, this.modeBar, this.padView, this.monitorView));
		this.setMode(this.prefs.mode);
	}

	save() {
		writeJSON(PREFS_KEY, { version: PREFS_VERSION, ...this.prefs });
	}

	setMode(mode) {
		this.prefs.mode = mode;
		this.save();
		for (const b of this.modeBar.children) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
		this.padView.hidden = mode !== 'pad';
		this.monitorView.hidden = mode !== 'monitor';
		if (mode === 'monitor') {
			this.stop();
			this.release ??= this.hub.take();
		} else {
			this.release?.();
			this.release = null;
		}
		this.renderPads();
		this.onHosts();
	}

	// --- Controller: choosing a host and a layout ---

	buildSetup() {
		this.hostChips = h('div', { class: 'controller-hosts' });
		this.noHost = h('p', { class: 'hint' }, 'Nobody takes input yet. On the device that should get it, open Controller → Monitor.');
		this.layoutBar = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Layout' },
			...Object.entries(LAYOUTS).map(([id, label]) => h('button', {
				type: 'button', class: 'segment', 'data-layout': id,
				onclick: () => {
					this.prefs.layout = id;
					this.save();
					this.renderLayout();
				},
			}, label)));
		this.gamepadLine = h('p', { class: 'hint controller-gamepads' });
		this.startBtn = button('Start', 'play', () => this.start(), 'btn primary large');
		const view = h('div', { class: 'controller-setup' },
			h('h3', {}, 'Send to'), this.hostChips, this.noHost,
			h('h3', {}, 'Layout'), this.layoutBar,
			this.gamepadLine,
			this.startBtn);
		this.renderLayout();
		this.renderGamepads();
		return view;
	}

	renderLayout() {
		for (const b of this.layoutBar.children) b.setAttribute('aria-pressed', String(b.dataset.layout === this.prefs.layout));
	}

	/** The host to send to: the one chosen before if it is here, else the first. */
	target() {
		const hosts = this.hosts.list();
		return hosts.find(m => m.deviceId === this.prefs.host) ?? hosts[0] ?? null;
	}

	onHosts() {
		const hosts = this.hosts.list();
		const target = this.target();
		this.hostChips.replaceChildren(...hosts.map(member => h('button', {
			type: 'button',
			class: 'host-chip',
			'aria-pressed': String(member === target),
			style: `--member: ${member.color}`,
			onclick: () => {
				this.prefs.host = member.deviceId;
				this.save();
				this.onHosts();
			},
		}, h('span', { class: 'dot' }), member.name)));
		this.noHost.hidden = hosts.length > 0;
		this.startBtn.disabled = !target;
		if (!this.play) return;
		const host = hosts.find(m => m.peerId === this.play.host);
		if (host) this.play.hostName.textContent = host.name;
		else if (this.room.member(this.play.host)) {
			toast(`${this.room.member(this.play.host).name} stopped taking input`);
			this.stop();
		}
	}

	gamepads() {
		return [...(navigator.getGamepads?.() ?? [])].filter(Boolean).filter(gp => gp.index < MAX_GAMEPADS);
	}

	renderGamepads() {
		const pads = this.gamepads();
		this.gamepadLine.textContent = pads.length
			? `Gamepad${pads.length > 1 ? 's' : ''} here, sent along while playing: ${pads.map(gp => gp.id.split('(')[0].trim() || 'Gamepad').join(', ')}`
			: 'A gamepad plugged into this device is sent along while playing.';
	}

	// --- Controller: playing ---

	async start() {
		const host = this.target();
		if (!host || this.play) return;
		const layout = this.prefs.layout;
		const sender = new InputSender(this.room, host.peerId);
		const surface = h('div', { class: 'pad-surface', 'data-layout': layout });
		const hostName = h('span', { class: 'pad-host', style: `--member: ${host.color}` }, host.name);
		const latency = h('span', { class: 'pad-latency' });
		const stopBtn = h('button', { type: 'button', class: 'pad-top-btn', 'aria-label': 'Stop', title: 'Stop', onclick: () => this.stop() }, icon('close'));
		const top = h('div', { class: 'pad-top' }, hostName, latency, stopBtn);
		const el = h('div', { class: 'pad-play' }, top, surface);
		const play = (this.play = {
			host: host.peerId, layout, sender, el, surface, hostName, latency, zones: [], pointers: new Map(), buttons: 0,
			motion: null, quat: null, full: false, frame: 0, gamepads: new Set(),
		});
		if (layout === 'nes') this.buildNes(play);
		else this.buildMotion(play, top);
		surface.addEventListener('pointerdown', e => this.onPointer(e));
		surface.addEventListener('pointermove', e => this.onPointer(e));
		for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) surface.addEventListener(type, e => this.onPointerEnd(e));
		surface.addEventListener('contextmenu', e => e.preventDefault()); // a long press is a held button
		document.body.append(el);
		wakeLock.acquire();
		sender.set(0, { buttons: 0 }); // the host shows the pad at once
		this.pollGamepads();
		try {
			await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
			play.full = Boolean(document.fullscreenElement);
			await screen.orientation?.lock?.('landscape');
		} catch {
			// Not allowed here (a desktop browser, or iOS): the pad works in the page as it is.
		}
	}

	buildNes(play) {
		const zone = (index, label, cls) => {
			const el = h('div', { class: `pad-btn ${cls}`, 'data-button': index, 'aria-label': label }, label);
			play.zones.push({ el, bits: () => bit(index) });
			return el;
		};
		const dpad = h('div', { class: 'pad-dpad', 'aria-label': 'D-pad' },
			...['up', 'down', 'left', 'right'].map(dir => h('span', { class: `pad-arrow ${dir}` })));
		play.zones.push({ el: dpad, dpad: true });
		play.surface.append(
			h('div', { class: 'pad-left' }, dpad),
			h('div', { class: 'pad-middle' }, zone(B.SELECT, 'Select', 'small'), zone(B.START, 'Start', 'small')),
			h('div', { class: 'pad-right' }, zone(B.SOUTH, 'B', 'round b'), zone(B.EAST, 'A', 'round a')));
	}

	buildMotion(play, top) {
		const trigger = h('div', { class: 'pad-btn trigger', 'data-button': B.RT, 'aria-label': 'Trigger' }, 'Trigger');
		play.zones.push({ el: trigger, bits: () => bit(B.RT) });
		const status = h('p', { class: 'pad-motion-status' }, 'Starting motion…');
		top.insertBefore(button('Recenter', 'fit', () => play.motion?.recenter(), 'pad-top-btn text'), top.lastChild);
		play.surface.append(h('div', { class: 'pad-motion' }, trigger, status));
		play.motion = new Motion(quat => {
			play.quat = quat;
			this.sendPad();
		});
		play.motion.start().then(source => {
			if (this.play !== play) return;
			status.textContent = source ? 'Tilt and turn the phone; Recenter makes the way it points now straight ahead.'
				: 'This device gives no orientation: only the trigger is sent.';
		});
	}

	/** Which buttons a point presses: the zone under it, or the nearest one within SLOP. */
	hit(x, y) {
		let best = null;
		let bestDist = SLOP;
		for (const zone of this.play.zones) {
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
		const play = this.play;
		if (!play) return;
		if (e.type === 'pointerdown') {
			e.preventDefault();
			try {
				play.surface.setPointerCapture(e.pointerId);
			} catch {
				// a pointer that is already gone
			}
		} else if (!play.pointers.has(e.pointerId)) return; // a hovering mouse
		play.pointers.set(e.pointerId, this.hit(e.clientX, e.clientY));
		this.sendPad();
	}

	onPointerEnd(e) {
		if (!this.play?.pointers.delete(e.pointerId)) return;
		this.sendPad();
	}

	sendPad() {
		const play = this.play;
		if (!play) return;
		let buttons = 0;
		for (const bits of play.pointers.values()) buttons |= bits;
		const pressed = buttons & ~play.buttons;
		if (pressed) navigator.vibrate?.(12);
		play.buttons = buttons;
		for (const zone of play.zones) {
			const on = zone.dpad ? (buttons & (bit(B.UP) | bit(B.DOWN) | bit(B.LEFT) | bit(B.RIGHT))) !== 0 : (buttons & zone.bits()) !== 0;
			zone.el.classList.toggle('on', on);
			if (zone.dpad) for (const [dir, i] of [['up', B.UP], ['down', B.DOWN], ['left', B.LEFT], ['right', B.RIGHT]]) {
				zone.el.querySelector(`.${dir}`).classList.toggle('on', (buttons & bit(i)) !== 0);
			}
		}
		play.sender.set(0, { buttons, quat: play.quat });
	}

	/** Gamepads plugged into this device, read every frame while playing (the Gamepad API has no events for input). */
	pollGamepads() {
		const play = this.play;
		if (!play) return;
		const seen = new Set();
		for (const gp of this.gamepads()) {
			const slot = gp.index + 1;
			seen.add(slot);
			let buttons = 0;
			gp.buttons.slice(0, BUTTONS).forEach((b, i) => {
				if (b?.pressed) buttons |= bit(i);
			});
			play.sender.set(slot, { buttons, axes: [...gp.axes].slice(0, 4) });
		}
		for (const slot of play.gamepads) if (!seen.has(slot)) play.sender.leave(slot);
		play.gamepads = seen;
		play.frame = requestAnimationFrame(() => this.pollGamepads());
	}

	stop() {
		const play = this.play;
		if (!play) return;
		this.play = null;
		cancelAnimationFrame(play.frame);
		play.motion?.stop();
		play.sender.destroy();
		play.el.remove();
		wakeLock.release();
		try {
			screen.orientation?.unlock?.();
		} catch {
			// never locked
		}
		if (play.full && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
	}

	// --- Monitor ---

	renderPads() {
		const pads = this.prefs.mode === 'monitor' ? this.hub.list() : [];
		const had = this.cards.size;
		for (const [slot, card] of [...this.cards]) {
			if (!pads.some(pad => pad.index === slot)) {
				card.el.remove();
				this.cards.delete(slot);
			}
		}
		for (const pad of pads) {
			let card = this.cards.get(pad.index);
			if (!card) {
				card = this.buildCard(pad.index);
				this.cards.set(pad.index, card);
			}
			card.name.textContent = pad.name;
			card.el.style.setProperty('--member', pad.color);
			card.kind.textContent = `Player ${pad.index + 1} · ${pad.local ? `gamepad ${pad.local}` : 'screen'}`;
			this.monitorList.append(card.el); // in slot order
			this.markDirty(pad.index);
		}
		this.monitorEmpty.hidden = pads.length > 0;
		if (this.cards.size > had && !this.ctx.visible()) this.ctx.notify();
	}

	buildCard(slot) {
		const buttons = BUTTON_NAMES.map((label, i) => h('span', { class: 'mon-btn', 'data-button': i }, label));
		const stick = () => {
			const dot = h('span', { class: 'mon-dot' });
			return { el: h('span', { class: 'mon-stick' }, dot), dot };
		};
		const sticks = [stick(), stick()];
		const cube = h('div', { class: 'mon-cube' }, ...['front', 'back', 'right', 'left', 'top', 'bottom'].map(face => h('span', { class: `face ${face}` }, face === 'front' ? 'screen' : '')));
		const card = {
			slot,
			name: h('strong', {}),
			kind: h('span', { class: 'mon-kind' }),
			buttons,
			sticks,
			cube,
			motion: h('div', { class: 'mon-motion' }, h('div', { class: 'mon-cube-stage' }, cube)),
			stats: h('span', { class: 'mon-stats' }),
		};
		card.el = h('article', { class: 'mon-card', 'data-slot': slot },
			h('header', {}, h('span', { class: 'dot' }), card.name, card.kind, card.stats),
			h('div', { class: 'mon-buttons' }, ...buttons),
			h('div', { class: 'mon-axes' }, ...sticks.map(s => s.el)),
			card.motion);
		return card;
	}

	markDirty(slot) {
		this.dirty.add(slot);
		this.frame ||= requestAnimationFrame(() => {
			this.frame = 0;
			for (const s of this.dirty) this.renderCard(s);
			this.dirty.clear();
		});
	}

	/** One card in place: lit buttons, sticks, the cube. */
	renderCard(slot) {
		const card = this.cards.get(slot);
		const pad = this.hub.getPad(slot);
		if (!card || !pad) return;
		pad.buttons.forEach((b, i) => card.buttons[i].classList.toggle('on', b.pressed));
		card.sticks.forEach((stick, i) => {
			const [x, y] = [pad.axes[i * 2], pad.axes[i * 2 + 1]];
			stick.dot.style.transform = `translate(${(x * 50).toFixed(1)}%, ${(y * 50).toFixed(1)}%)`;
		});
		card.motion.hidden = !pad.orientation;
		if (pad.orientation) card.cube.style.transform = cssRotation(pad.orientation);
	}

	renderStats() {
		const now = performance.now();
		for (const [slot, card] of this.cards) {
			const pad = this.hub.pads.get(slot);
			if (!pad) continue;
			const quiet = now - pad.at > INPUT_TIMING.quiet;
			const parts = [];
			if (pad.rtt != null) parts.push(`${Math.max(1, Math.round(pad.rtt / 2))} ms`);
			parts.push(quiet ? 'idle' : `${this.hub.rate(slot)}/s`);
			card.stats.textContent = parts.join(' · ');
			card.stats.title = 'Latency (half the round trip of the input channel) and messages per second';
			card.el.classList.toggle('quiet', quiet);
		}
		if (this.play) {
			const rtt = this.play.sender.rtt;
			this.play.latency.textContent = rtt == null ? '' : `${Math.max(1, Math.round(rtt / 2))} ms`;
		}
	}

	destroy() {
		this.stop();
		this.release?.();
		clearInterval(this.statsTimer);
		cancelAnimationFrame(this.frame);
		for (const off of this.subs) off();
		this.hosts.destroy();
		window.removeEventListener('gamepadconnected', this.onGamepads);
		window.removeEventListener('gamepaddisconnected', this.onGamepads);
		document.removeEventListener('fullscreenchange', this.onFullscreen);
	}
}
