import { button, h, toast } from '../../ui/dom.js';
import { readJSON, writeJSON } from '../../util.js';
import { BUTTON_NAMES, HostList, INPUT_TIMING, InputHub } from './input.js';
import { LAYOUTS, PadPlay, localGamepads } from './pad.js';

const PREFS_KEY = 'peerkit.controller';
const PREFS_VERSION = 1;
const MODES = ['pad', 'monitor'];

/*
 * The Controller tool: this device as a game pad for another member (Controller), or the input that reaches it
 * (Monitor). Messages and pacing are in input.js; the Monitor holds the room's InputHub, which is what makes this
 * device a host that controllers can choose. The full-screen pad itself is pad.js.
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
			this.hub.on('seats', () => this.renderPads()),
			this.hub.on('state', slot => this.markDirty(slot)),
		];
		this.statsTimer = setInterval(() => this.renderStats(), 250);
		this.onGamepads = () => this.renderGamepads();
		window.addEventListener('gamepadconnected', this.onGamepads);
		window.addEventListener('gamepaddisconnected', this.onGamepads);

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
		if (host) this.play.setHostName(host.name);
		else if (this.room.member(this.play.host)) {
			toast(`${this.room.member(this.play.host).name} stopped taking input`);
			this.stop();
		}
	}

	renderGamepads() {
		const pads = localGamepads();
		this.gamepadLine.textContent = pads.length
			? `Gamepad${pads.length > 1 ? 's' : ''} here, sent along while playing: ${pads.map(gp => gp.id.split('(')[0].trim() || 'Gamepad').join(', ')}`
			: 'A gamepad plugged into this device is sent along while playing.';
	}

	// --- Controller: playing ---

	start() {
		const host = this.target();
		if (!host || this.play) return;
		this.play = new PadPlay(this.room, host, {
			layout: this.prefs.layout,
			onStop: () => {
				this.play = null;
			},
		});
	}

	stop() {
		this.play?.stop();
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
			const seat = this.hub.seats ? this.hub.seats.get(pad.index) : pad.index; // a game's players, else in order
			card.kind.textContent = `${seat === undefined ? 'Not playing' : `Player ${seat + 1}`} · ${pad.local ? `gamepad ${pad.local}` : 'screen'}`;
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
	}
}
