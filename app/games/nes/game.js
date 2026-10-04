import { sha256, toHex } from '../../crypto.js';
import { button, h, icon, openDialog, toast } from '../../ui/dom.js';
import { indexedDBUsable, readJSON, timeAgo, writeJSON } from '../../util.js';
import { download } from '../../tools/chat/viewer.js';
import { PadPlay, localGamepads } from '../../tools/controller/pad.js';
import { Emulator, MAX_ROM, MAX_STATE, NES_BUTTONS, PADS, isState, romKind } from './emulator.js';
import { Library, SLOTS } from './library.js';
import { NES, gamepadBits, keyLabel, nesBits, readKeys } from './players.js';

const PREFS_KEY = 'peerkit.nes';
const PREFS_VERSION = 1;
const MAX_TITLE = 80;
const TAP_FRAMES = 2; // a press shorter than a frame is held this many frames, so the game sees it

/*
 * The NES as a game module of the Games tool (app/tools/games/games.js): FCEUX (emulator.js) with a ROM from this
 * device. Its lobby opens a ROM or continues one of the last ones (library.js); while it runs: Touch pad, Reset,
 * Mute, Keys…, save slots per ROM and export/import, and the picture and sound for Remote play. Four players
 * through Four Score: the seats' sources become NES buttons before every frame (players.js). On a touch screen the
 * host can play too: Touch pad puts the NES pad over its own picture (full screen), as part of "this device" with
 * its keys and gamepad.
 */

export default {
	id: 'nes',
	title: 'NES',
	about: 'Open a NES ROM you own (.nes). The game runs on this device; the others play it from their phones. No games come with PeerKit.',
	layout: 'nes',
	players: { min: 1, max: PADS },
	thisDevice: true,
	wrapClass: 'nes-screen-wrap',
	supported: () => typeof WebAssembly === 'object',
	lobby: ({ start }) => new NesLobby(start),
	mount: (session, { rom }) => new NesGame(session, rom),
};

const titleOf = fileName => fileName.replace(/\.(nes|unf|unif)$/i, '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_TITLE) || 'Game';
const touchScreen = () => matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
const typing = target => Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"], .cm-editor, .monaco-editor'));

function loadPrefs() {
	const raw = readJSON(PREFS_KEY);
	const ok = raw?.version === PREFS_VERSION;
	return { keys: readKeys(ok ? raw.keys : null), muted: ok && raw.muted === true };
}

const savePrefs = prefs => writeJSON(PREFS_KEY, { version: PREFS_VERSION, ...prefs });

// The ROMs and saves on this device, opened once.
let libraryReady = null;
const openLibrary = () => {
	libraryReady ??= indexedDBUsable().then(ok => (ok ? Library.open() : null)).catch(() => null);
	return libraryReady;
};

/** "Play here" for the NES: open a ROM, or continue one of the last. */
class NesLobby {
	constructor(start) {
		this.start = start;
		this.library = null;
		this.fileInput = h('input', {
			type: 'file', accept: '.nes,.unf,.unif', hidden: true,
			onchange: () => {
				const file = this.fileInput.files?.[0];
				this.fileInput.value = '';
				this.openFile(file);
			},
		});
		this.recentList = h('div', { class: 'nes-recent' });
		this.recent = h('div', { class: 'games-sub', hidden: true }, h('h4', {}, 'Continue'), this.recentList);
		this.el = h('div', { class: 'games-sub' },
			button('Open a ROM…', 'upload', () => this.fileInput.click(), 'btn primary'),
			this.fileInput,
			this.recent);
		openLibrary().then(library => {
			this.library = library;
			this.refresh();
		});
	}

	async refresh() {
		if (!this.library) return;
		let roms = [];
		try {
			roms = await this.library.roms();
		} catch {
			// storage went away: nothing to continue
		}
		this.recentList.replaceChildren(...roms.map(rom => h('div', { class: 'nes-rom', 'data-hash': rom.hash },
			h('div', { class: 'games-text' }, h('strong', {}, rom.name), h('span', { class: 'hint' }, timeAgo(rom.used))),
			button('Play', 'play', () => this.continueRom(rom.hash), 'btn small'),
			h('button', {
				type: 'button', class: 'icon-btn', 'aria-label': `Forget ${rom.name}`, title: 'Forget',
				onclick: async () => {
					await this.library.removeRom(rom.hash).catch(() => {});
					this.refresh();
				},
			}, icon('close')))));
		this.recent.hidden = roms.length === 0;
	}

	async openFile(file) {
		if (!file) return;
		if (file.size > MAX_ROM) {
			toast('That file is too big for a NES ROM.');
			return;
		}
		const bytes = new Uint8Array(await file.arrayBuffer());
		if (!romKind(bytes)) {
			toast('That isn’t a NES ROM (.nes or .unf).');
			return;
		}
		const rom = { hash: toHex(sha256(bytes)), name: titleOf(file.name), bytes };
		this.library?.addRom(rom).catch(() => {});
		this.start({ rom });
	}

	async continueRom(hash) {
		const rom = await this.library?.rom(hash).catch(() => null);
		if (!rom) {
			toast('That ROM is no longer on this device.');
			this.refresh();
			return;
		}
		this.library.addRom(rom).catch(() => {}); // used now
		this.start({ rom });
	}
}

/** One NES game running here. */
class NesGame {
	constructor(session, rom) {
		this.session = session;
		this.rom = rom;
		this.title = rom.name;
		this.prefs = loadPrefs();
		this.library = null;
		this.emulator = null;
		this.keyBits = 0;
		this.touch = null; // the pad over the picture, while it's open
		this.touchBits = 0;
		this.latched = new Map(); // source → {bits, until}: short presses held for TAP_FRAMES
		this.saves = new Map();
		this.destroyed = false;
		this.hostLabel = touchScreen() ? 'This device (touch pad, keys, gamepad)' : 'This device (keyboard, gamepad)';
		this.playersNote = 'Players 3 and 4 need a game made for four (Four Score).';

		this.el = h('div', { class: 'nes-screen' });
		this.muteBtn = h('button', { type: 'button', class: 'btn small', onclick: () => this.toggleMute() });
		this.touchBtn = button('Touch pad', 'gamepad', () => this.openTouchPad(), 'btn small primary');
		this.touchBtn.hidden = !touchScreen();
		this.toolbar = [this.touchBtn, button('Reset', 'undo', () => this.reset()), this.muteBtn];
		this.playersExtra = [button('Keys…', 'settings', () => this.editKeys())];
		this.saveRows = h('div', { class: 'nes-saves' });
		this.importInput = h('input', {
			type: 'file', accept: '.fcs,.frz', hidden: true,
			onchange: () => {
				const file = this.importInput.files?.[0];
				this.importInput.value = '';
				this.importState(file);
			},
		});
		this.panels = [h('section', { class: 'games-section' },
			h('h3', {}, 'Saves'),
			this.saveRows,
			h('div', { class: 'games-row' },
				button('Export', 'download', () => this.exportState()),
				button('Import…', 'upload', () => this.importInput.click()),
				this.importInput))];
		this.renderMute();
		this.renderSaves();

		this.subs = [
			session.on('press', (source, index) => this.latch(source, nesBits(1 << index))),
			session.on('status', () => this.renderTouch()),
		];
		this.onKey = e => this.key(e);
		this.onBlur = () => (this.keyBits = 0);
		window.addEventListener('keydown', this.onKey);
		window.addEventListener('keyup', this.onKey);
		window.addEventListener('blur', this.onBlur);

	}

	async start() {
		await this.boot();
		this.loadSaves();
	}

	async boot() {
		const emulator = new Emulator(this.el);
		this.emulator = emulator;
		emulator.beforeFrame = () => this.applyInput();
		emulator.on('sound', () => this.session.changed());
		emulator.setMuted(this.prefs.muted);
		try {
			await emulator.boot(this.rom.bytes);
		} catch (err) {
			emulator.destroy();
			if (this.destroyed) throw new Error('');
			throw new Error(err.message === 'not a game' ? 'FCEUX couldn’t start this ROM.' : 'The emulator could not be loaded. Check the connection and try again.');
		}
		if (this.destroyed) {
			emulator.destroy();
			throw new Error('');
		}
		if (this.session.paused) emulator.setPaused(true);
		this.session.changed();
	}

	/** Reset: the build has none, so the ROM boots again; players, saves and viewers stay. */
	async reset() {
		if (!this.emulator?.module) return;
		this.emulator.destroy();
		this.emulator = null;
		try {
			await this.boot();
		} catch (err) {
			if (this.destroyed) return;
			toast('The game could not start again.');
			this.session.stop();
			return;
		}
		this.session.restream();
	}

	setPaused(paused) {
		this.emulator?.setPaused(paused);
		this.renderTouch();
	}

	notice() {
		return this.emulator?.soundBlocked ? 'Tap for sound' : '';
	}

	tap() {
		this.emulator?.unblockSound();
	}

	canStream() {
		return typeof this.emulator?.canvas?.captureStream === 'function';
	}

	stream() {
		return this.emulator?.module ? this.emulator.captureStream() : null;
	}

	toggleMute() {
		this.prefs.muted = !this.prefs.muted;
		savePrefs(this.prefs);
		this.emulator?.setMuted(this.prefs.muted);
		this.renderMute();
	}

	renderMute() {
		this.muteBtn.replaceChildren(icon(this.prefs.muted ? 'volume-x' : 'volume'), this.prefs.muted ? 'Unmute' : 'Mute');
		this.muteBtn.setAttribute('aria-pressed', String(this.prefs.muted));
	}

	// --- a touch pad over this device's own picture ---

	/** The NES pad over this device's own picture, full screen: this device plays with its fingers. */
	openTouchPad() {
		if (!this.emulator?.module || this.touch) return;
		this.emulator.unblockSound(); // a tap: the browser lets the sound start now
		const pauseBtn = h('button', { type: 'button', class: 'pad-top-btn text', onclick: () => this.session.togglePause() });
		const room = this.session.room;
		const wrap = this.session.wrap;
		const play = new PadPlay(room, { peerId: room.self.peerId, name: this.title, color: room.self.color }, {
			layout: 'nes',
			container: wrap,
			actions: [pauseBtn],
			sink: state => this.onTouch(state),
			onStop: () => {
				if (this.touch === play) this.touch = null;
				this.touchBits = 0;
				wrap.classList.remove('pad-on');
			},
		});
		play.pauseBtn = pauseBtn;
		this.touch = play;
		wrap.classList.add('pad-on'); // the picture fills the screen even where full screen isn't allowed
		this.renderTouch();
	}

	renderTouch() {
		if (!this.touch) return;
		const paused = this.session.paused;
		this.touch.pauseBtn.replaceChildren(icon(paused ? 'play' : 'pause'), paused ? 'Resume' : 'Pause');
		this.touch.setHostName(this.session.status());
	}

	onTouch({ buttons }) {
		const bits = nesBits(buttons);
		const pressed = bits & ~this.touchBits;
		this.touchBits = bits;
		if (!pressed) return;
		this.latch('host', pressed);
		this.emulator?.unblockSound();
	}

	// --- input ---

	latch(source, bits) {
		if (!bits || !this.emulator) return;
		const frames = this.emulator.frames;
		const held = this.latched.get(source);
		this.latched.set(source, { bits: (held && frames < held.until ? held.bits : 0) | bits, until: frames + TAP_FRAMES });
	}

	/** Before every frame: each seat's buttons to its NES pad. */
	applyInput() {
		const emulator = this.emulator;
		const seats = this.session.seats;
		const frames = emulator.frames;
		const gamepads = localGamepads();
		for (const gp of gamepads) if (gp.index > 0 && !seats.known.has(`gp:${gp.index}`)) seats.arrive(`gp:${gp.index}`);
		const bitsOf = source => {
			let bits = 0;
			if (source === 'host') bits = this.keyBits | this.touchBits | gamepadBits(gamepads.find(gp => gp.index === 0));
			else if (source.startsWith('gp:')) bits = gamepadBits(gamepads.find(gp => gp.index === Number(source.slice(3))));
			else {
				const pad = this.session.pad(source);
				if (pad) bits = nesBits(pad.buttons, pad.axes);
			}
			const held = this.latched.get(source);
			if (held) {
				if (frames < held.until) bits |= held.bits;
				else this.latched.delete(source);
			}
			return bits;
		};
		seats.seats.forEach((source, i) => emulator.setPad(i, source ? bitsOf(source) : 0));
	}

	key(e) {
		if (!this.emulator?.module) return;
		const name = NES_BUTTONS.find(n => this.prefs.keys[n] === e.code);
		if (!name) return;
		if (e.type === 'keyup') {
			this.keyBits &= ~NES[name];
			return;
		}
		if (!this.session.visible() || typing(e.target) || document.querySelector('dialog[open]')) return;
		e.preventDefault();
		this.emulator.unblockSound();
		if (e.repeat) return;
		this.keyBits |= NES[name];
		this.latch('host', NES[name]);
	}

	editKeys() {
		let waiting = null; // the button name whose key is being chosen
		const rows = new Map();
		const render = () => {
			for (const [name, btn] of rows) btn.textContent = waiting === name ? 'Press a key…' : keyLabel(this.prefs.keys[name]);
		};
		const capture = e => {
			if (!waiting) return;
			e.preventDefault();
			e.stopPropagation();
			if (e.code !== 'Escape' && /^[A-Za-z0-9]{1,24}$/.test(e.code)) {
				for (const n of NES_BUTTONS) if (n !== waiting && this.prefs.keys[n] === e.code) this.prefs.keys[n] = this.prefs.keys[waiting]; // swap
				this.prefs.keys[waiting] = e.code;
				savePrefs(this.prefs);
			}
			waiting = null;
			render();
		};
		const list = h('div', { class: 'nes-keys' }, ...NES_BUTTONS.map(name => {
			const btn = h('button', {
				type: 'button', class: 'btn small', 'data-button': name,
				onclick: () => {
					waiting = name;
					render();
				},
			});
			rows.set(name, btn);
			return h('label', { class: 'games-seat' }, h('span', {}, name), btn);
		}));
		const dialog = openDialog(h('div', { class: 'sheet-body' },
			h('h2', {}, 'Keys'),
			h('p', { class: 'hint' }, 'The keys on this device for Player 1 (or whoever has "This device"). Tap a button, then press the key.'),
			list,
			h('div', { class: 'games-row' },
				button('Defaults', 'undo', () => {
					this.prefs.keys = readKeys(null);
					savePrefs(this.prefs);
					render();
				}),
				button('Done', null, () => dialog.close(), 'btn small primary'))));
		window.addEventListener('keydown', capture, true);
		dialog.addEventListener('close', () => window.removeEventListener('keydown', capture, true));
		render();
		return dialog;
	}

	// --- saves ---

	async loadSaves() {
		this.library = await openLibrary();
		if (!this.library || this.destroyed) return;
		this.saves = await this.library.saves(this.rom.hash).catch(() => new Map());
		this.renderSaves();
	}

	renderSaves() {
		if (!this.library) {
			libraryReady?.then(library => {
				if (!library && !this.destroyed) this.saveRows.replaceChildren(h('p', { class: 'hint' }, 'This browser keeps nothing here: save with Export, and load the file with Import.'));
			});
			return;
		}
		this.saveRows.replaceChildren(...Array.from({ length: SLOTS }, (_, i) => {
			const slot = i + 1;
			const saved = this.saves.get(slot);
			return h('div', { class: 'nes-save', 'data-slot': slot },
				h('span', {}, `Slot ${slot}`),
				h('span', { class: 'hint' }, saved ? timeAgo(saved.time) : 'empty'),
				button('Save', 'download', () => this.saveSlot(slot)),
				Object.assign(button('Load', 'upload', () => this.loadSlot(slot)), { disabled: !saved }));
		}));
	}

	async saveSlot(slot) {
		const bytes = this.emulator?.saveState();
		if (!bytes || !this.library) {
			toast('Could not save.');
			return;
		}
		try {
			await this.library.putSave(this.rom.hash, slot, bytes);
		} catch {
			toast('Could not save: the storage is full or blocked.');
			return;
		}
		this.saves.set(slot, { time: Date.now() });
		this.renderSaves();
		toast(`Saved in slot ${slot}`);
	}

	async loadSlot(slot) {
		if (!this.emulator) return;
		const bytes = await this.library?.save(this.rom.hash, slot).catch(() => null);
		if (bytes && this.emulator?.loadState(bytes)) toast(`Slot ${slot} loaded`);
		else toast('That save could not be loaded.');
	}

	exportState() {
		const bytes = this.emulator?.saveState();
		if (!bytes) return;
		download(bytes, `${this.title}.fcs`);
	}

	async importState(file) {
		const emulator = this.emulator;
		if (!file || !emulator) return;
		const bytes = file.size <= MAX_STATE ? new Uint8Array(await file.arrayBuffer()) : null;
		if (bytes && isState(bytes) && emulator.loadState(bytes)) toast('Save loaded');
		else toast('That isn’t an FCEUX save state.');
	}

	destroy() {
		this.destroyed = true;
		this.touch?.stop();
		this.emulator?.destroy();
		for (const off of this.subs) off();
		window.removeEventListener('keydown', this.onKey);
		window.removeEventListener('keyup', this.onKey);
		window.removeEventListener('blur', this.onBlur);
	}
}
