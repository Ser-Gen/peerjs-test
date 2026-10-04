import { sha256, toHex } from '../../crypto.js';
import { musicSdp } from '../../mediacall.js';
import { CH } from '../../protocol.js';
import { memberColor } from '../../room.js';
import { button, h, icon, openDialog, toast } from '../../ui/dom.js';
import { indexedDBUsable, readJSON, timeAgo, wakeLock, writeJSON } from '../../util.js';
import { download } from '../chat/viewer.js';
import { InputHub } from '../controller/input.js';
import { PadPlay, localGamepads } from '../controller/pad.js';
import { Emulator, MAX_ROM, MAX_STATE, NES_BUTTONS, PADS, isState, romKind } from './emulator.js';
import { Library, SLOTS } from './library.js';
import { NES, Seats, gamepadBits, keyLabel, nesBits, readKeys } from './players.js';

const PREFS_KEY = 'peerkit.nes';
const PREFS_VERSION = 1;
const MAX_TITLE = 80;
const MAX_NAME = 40;
const TAP_FRAMES = 2; // a press shorter than a frame is held this many frames, so the game sees it

/*
 * The NES tool: a member runs FCEUX (emulator.js) with a ROM from its own device, and the others play it with
 * their phones. On the host: the picture, Pause, Reset, Mute, full screen, four players (this device's keyboard
 * and gamepads, and members' pads through the InputHub, which this device holds while a game runs), save slots
 * per ROM and export/import. On a touch screen the host can play too: Touch pad puts the NES pad over its own
 * picture (full screen), as part of "this device" with its keys and gamepad. A guest picks a member's game and plays it as a pad (Controller), or with the
 * picture and sound streamed to it behind the pad (Remote play).
 *
 * Protocol (ch: 'nes'); the pads themselves are ch 'input' (app/tools/controller/input.js):
 *   game  {title, paused, remote, players}
 *                                   host → members: a game runs (on start, on every change, on link up);
 *                                   title null: it stopped. `remote`: the picture can be streamed. `players`: the
 *                                   four seats, each null or {device, pad, name, away}: whose device (its ID, so a
 *                                   reload keeps it), which of its pads (0 its screen or keys, n its gamepad n),
 *                                   the name the host knows and whether that pad is gone for now.
 *   watch {on}                      guest → host: send me the picture (a media call, metadata {kind: 'nes'}) or stop
 *   seat  {seat}                    guest → host: put my screen pad on this seat (0–3) if it's free
 * A seated member's pad that goes away pauses the game, and it goes on when the pad comes back.
 */

export default {
	id: 'nes',
	title: 'NES',
	supported: () => typeof WebAssembly === 'object' && typeof RTCPeerConnection === 'function',
	mount(el, room, ctx) {
		const tool = new NesTool(el, room, ctx);
		return () => tool.destroy();
	},
};

/** A `game` message: {title, paused, remote, players}, null for a stopped game, undefined for one that isn't valid. */
export function readGame(msg) {
	if (msg?.title === null) return null;
	if (typeof msg?.title !== 'string') return undefined;
	const title = msg.title.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_TITLE);
	if (!title) return undefined;
	return { title, paused: msg.paused === true, remote: msg.remote === true, players: readPlayers(msg.players) };
}

/** The four seats of a `game` message; a seat that isn't valid is empty. */
export function readPlayers(raw) {
	return Array.from({ length: PADS }, (_, i) => {
		const p = Array.isArray(raw) ? raw[i] : null;
		if (!p || typeof p !== 'object') return null;
		if (typeof p.device !== 'string' || !/^[0-9a-f]{8,64}$/.test(p.device)) return null;
		if (!Number.isInteger(p.pad) || p.pad < 0 || p.pad > 4) return null;
		const name = typeof p.name === 'string' ? p.name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_NAME) : '';
		return { device: p.device, pad: p.pad, name: name || 'A player', away: p.away === true };
	});
}

const titleOf = fileName => fileName.replace(/\.(nes|unf|unif)$/i, '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_TITLE) || 'Game';
const touchScreen = () => matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
const typing = target => Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"], .cm-editor, .monaco-editor'));

function loadPrefs() {
	const raw = readJSON(PREFS_KEY);
	const ok = raw?.version === PREFS_VERSION;
	return { keys: readKeys(ok ? raw.keys : null), muted: ok && raw.muted === true };
}

class NesTool {
	constructor(el, room, ctx) {
		this.el = el;
		this.room = room;
		this.ctx = ctx;
		this.prefs = loadPrefs();
		this.hub = InputHub.of(room);
		this.games = new Map(); // peer ID → {title, paused, remote}: the others' games
		this.game = null; // the game this device runs
		this.guest = null; // this device as a pad for someone's game
		this.library = null;
		this.libraryReady = indexedDBUsable()
			.then(ok => (ok ? Library.open() : null))
			.then(library => {
				this.library = library;
				this.renderRecent();
			})
			.catch(() => {});

		this.subs = [
			room.on(`msg:${CH.NES}`, (msg, member) => this.onMessage(msg, member)),
			room.on('link-up', member => {
				if (this.game?.emulator?.module) this.announce(member.peerId);
			}),
			room.on('link-down', member => {
				if (this.games.delete(member.peerId)) this.renderGames();
				if (this.game) {
					this.game.watchers.delete(member.peerId);
					this.game.viewers.get(member.peerId)?.close();
				}
			}),
			room.on('members', () => {
				this.renderGames();
				this.renderGuest();
			}),
			room.on('call', (call, member) => this.onCall(call, member)),
			this.hub.on('pads', () => this.onPads()),
			this.hub.on('press', (slot, button) => {
				if (this.game) this.latch(this.game, `pad:${slot}`, nesBits(1 << button));
			}),
		];
		this.onKey = e => this.key(e);
		this.onBlur = () => {
			if (this.game) this.game.keyBits = 0;
		};
		window.addEventListener('keydown', this.onKey);
		window.addEventListener('keyup', this.onKey);
		window.addEventListener('blur', this.onBlur);

		el.classList.add('nes');
		this.lobby = this.buildLobby();
		this.stage = this.buildStage();
		el.append(h('div', { class: 'nes-body' }, this.lobby, this.stage));
		this.renderGames();
	}

	save() {
		writeJSON(PREFS_KEY, { version: PREFS_VERSION, ...this.prefs });
	}

	// --- the lobby: the others' games, and a ROM to run here ---

	buildLobby() {
		this.gameList = h('div', { class: 'nes-games' });
		this.gamesSection = h('section', { class: 'nes-section' }, h('h3', {}, 'Games in this room'), this.gameList);
		this.fileInput = h('input', {
			type: 'file', accept: '.nes,.unf,.unif', hidden: true,
			onchange: () => {
				const file = this.fileInput.files?.[0];
				this.fileInput.value = '';
				this.openFile(file);
			},
		});
		this.recentList = h('div', { class: 'nes-recent' });
		this.recentSection = h('section', { class: 'nes-section', hidden: true }, h('h3', {}, 'Continue'), this.recentList);
		return h('div', { class: 'nes-lobby' },
			this.gamesSection,
			h('section', { class: 'nes-section' },
				h('h3', {}, 'Play here'),
				h('p', { class: 'hint' }, 'Open a NES ROM you own (.nes). The game runs on this device; the others play it from their phones. No games come with PeerKit.'),
				button('Open a ROM…', 'upload', () => this.fileInput.click(), 'btn primary'),
				this.fileInput),
			this.recentSection);
	}

	guestLabel(member, game = this.games.get(member.peerId)) {
		return `${member.name}${game ? ` · ${game.title}` : ''}${game?.paused ? ' · paused' : ''}`;
	}

	renderGames() {
		const rows = this.room.members.filter(m => this.games.has(m.peerId)).map(member => {
			const game = this.games.get(member.peerId);
			return h('div', { class: 'nes-game', style: `--member: ${member.color}`, 'data-peer': member.peerId },
				h('span', { class: 'dot' }),
				h('div', { class: 'nes-game-text' },
					h('strong', {}, game.title),
					h('span', { class: 'hint' }, `${member.name}${game.paused ? ' · paused' : ''}`)),
				button('Controller', 'gamepad', () => this.join(member, 'pad'), 'btn small'),
				game.remote ? button('Remote play', 'monitor', () => this.join(member, 'remote'), 'btn small') : null,
				h('div', { class: 'nes-players' }, ...game.players.map((player, i) => this.playerChip(player, i))));
		});
		this.gameList.replaceChildren(...rows);
		this.gamesSection.hidden = rows.length === 0;
	}

	/** Who a seat's player is, as this device knows them: the member's name now, else the name the host sent. */
	playerInfo(player) {
		if (!player) return null;
		const self = this.room.self;
		const member = player.device === self.deviceId ? self : this.room.members.find(m => m.deviceId === player.device);
		const name = `${member?.name ?? player.name}${player.pad ? ` (gamepad ${player.pad})` : ''}`;
		return { name, color: memberColor(player.device), mine: player.device === self.deviceId && player.pad === 0 };
	}

	playerChip(player, seat) {
		const info = this.playerInfo(player);
		return h('span', {
			class: `nes-player${info ? '' : ' free'}${player?.away ? ' away' : ''}${info?.mine ? ' mine' : ''}`,
			style: info ? `--member: ${info.color}` : '',
			'data-seat': seat,
		}, h('span', { class: 'dot' }), `${seat + 1} ${info ? info.name : 'free'}${player?.away ? ' (away)' : ''}`);
	}

	async renderRecent() {
		if (!this.library) return;
		let roms = [];
		try {
			roms = await this.library.roms();
		} catch {
			// storage went away: nothing to continue
		}
		this.recentList.replaceChildren(...roms.map(rom => h('div', { class: 'nes-rom', 'data-hash': rom.hash },
			h('div', { class: 'nes-game-text' }, h('strong', {}, rom.name), h('span', { class: 'hint' }, timeAgo(rom.used))),
			button('Play', 'play', () => this.continueRom(rom.hash), 'btn small'),
			h('button', {
				type: 'button', class: 'icon-btn', 'aria-label': `Forget ${rom.name}`, title: 'Forget',
				onclick: async () => {
					await this.library.removeRom(rom.hash).catch(() => {});
					this.renderRecent();
				},
			}, icon('close')))));
		this.recentSection.hidden = roms.length === 0;
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
		this.startGame(rom);
	}

	async continueRom(hash) {
		const rom = await this.library?.rom(hash).catch(() => null);
		if (!rom) {
			toast('That ROM is no longer on this device.');
			this.renderRecent();
			return;
		}
		this.library.addRom(rom).catch(() => {}); // used now
		this.startGame(rom);
	}

	// --- the host: running a game ---

	buildStage() {
		this.screen = h('div', { class: 'nes-screen' });
		this.notice = h('button', { type: 'button', class: 'nes-notice', hidden: true, onclick: () => this.onNotice() });
		this.screenWrap = h('div', { class: 'nes-screen-wrap', onpointerdown: () => this.game?.emulator?.unblockSound() }, this.screen, this.notice);
		this.titleEl = h('strong', { class: 'nes-title' });
		this.pauseBtn = h('button', { type: 'button', class: 'btn small', onclick: () => this.togglePause() });
		this.muteBtn = h('button', { type: 'button', class: 'btn small', onclick: () => this.toggleMute() });
		this.touchBtn = button('Touch pad', 'gamepad', () => this.openTouchPad(), 'btn small primary');
		const toolbar = h('div', { class: 'nes-toolbar' },
			this.titleEl,
			this.touchBtn,
			this.pauseBtn,
			button('Reset', 'undo', () => this.reset()),
			this.muteBtn,
			button('Full screen', 'maximize', () => this.screenWrap.requestFullscreen?.().catch(() => {})),
			button('Stop', 'stop', () => this.stopGame(), 'btn small danger'));
		this.seatRows = Array.from({ length: PADS }, (_, i) => {
			const select = h('select', { 'aria-label': `Player ${i + 1}`, onchange: () => this.game?.seats.assign(i, select.value || null) });
			return { select, el: h('label', { class: 'nes-seat' }, h('span', { class: 'dot' }), h('span', {}, `Player ${i + 1}`), select) };
		});
		this.seatNote = h('p', { class: 'hint' });
		const players = h('section', { class: 'nes-section' },
			h('h3', {}, 'Players'),
			...this.seatRows.map(r => r.el),
			this.seatNote,
			button('Keys…', 'settings', () => this.editKeys()));
		this.saveRows = h('div', { class: 'nes-saves' });
		this.importInput = h('input', {
			type: 'file', accept: '.fcs,.frz', hidden: true,
			onchange: () => {
				const file = this.importInput.files?.[0];
				this.importInput.value = '';
				this.importState(file);
			},
		});
		const saves = h('section', { class: 'nes-section' },
			h('h3', {}, 'Saves'),
			this.saveRows,
			h('div', { class: 'nes-row' },
				button('Export', 'download', () => this.exportState()),
				button('Import…', 'upload', () => this.importInput.click()),
				this.importInput));
		this.renderPause();
		this.renderMute();
		return h('div', { class: 'nes-stage', hidden: true },
			toolbar,
			this.screenWrap,
			h('div', { class: 'nes-panels' }, players, saves));
	}

	async startGame(rom) {
		this.stopGame();
		this.guest?.play.stop();
		const game = (this.game = {
			rom,
			emulator: null,
			seats: new Seats(),
			watchers: new Set(), // members that asked for the picture
			viewers: new Map(), // peer ID → the media call that sends it
			pausedFor: null, // 'user' | 'away'
			away: [],
			names: new Map(), // source → who it is, kept while it's away
			who: new Map(), // source 'pad:<n>' → {device, pad, name}, for the players in `game`, kept while it's away
			wants: new Map(), // device ID → the seat its member asked for before its pad arrived
			keyBits: 0,
			touch: null, // the pad over the picture, while it's open
			touchBits: 0,
			latch: new Map(), // source → {bits, until}: short presses held for TAP_FRAMES
			saves: new Map(),
			release: this.hub.take(),
		});
		game.seats.on('change', () => this.checkAway());
		this.titleEl.textContent = rom.name;
		this.touchBtn.hidden = !touchScreen();
		this.lobby.hidden = true;
		this.stage.hidden = false;
		wakeLock.acquire();
		this.renderSeats();
		this.renderSaves();
		try {
			await this.boot(game);
		} catch (err) {
			if (this.game !== game) return;
			toast(err.message === 'not a game' ? 'FCEUX couldn’t start this ROM.' : 'The emulator could not be loaded. Check the connection and try again.');
			this.stopGame();
			return;
		}
		this.onPads();
		this.announce();
		this.loadSaves(game);
	}

	async boot(game) {
		const emulator = new Emulator(this.screen);
		game.emulator = emulator;
		emulator.beforeFrame = () => this.applyInput(game);
		emulator.on('pause', () => {
			this.renderPause();
			this.announce();
		});
		emulator.on('sound', () => this.renderNotice());
		emulator.setMuted(this.prefs.muted);
		try {
			await emulator.boot(game.rom.bytes);
		} catch (err) {
			emulator.destroy();
			throw err;
		}
		if (this.game !== game) {
			emulator.destroy();
			throw new Error('stopped');
		}
		if (game.pausedFor) emulator.setPaused(true);
		this.renderPause();
		this.renderNotice();
		for (const peerId of game.watchers) this.callViewer(peerId);
	}

	/** Reset: the build has none, so the ROM boots again; players, saves and viewers stay. */
	async reset() {
		const game = this.game;
		if (!game?.emulator?.module) return;
		for (const call of game.viewers.values()) call.close();
		game.viewers.clear();
		game.emulator.destroy();
		game.emulator = null;
		try {
			await this.boot(game);
		} catch {
			if (this.game !== game) return;
			toast('The game could not start again.');
			this.stopGame();
		}
	}

	stopGame() {
		const game = this.game;
		if (!game) return;
		this.game = null;
		game.touch?.stop();
		game.emulator?.destroy();
		for (const call of game.viewers.values()) call.close();
		game.release();
		this.hub.setSeats(null);
		wakeLock.release();
		this.room.send(CH.NES, { type: 'game', title: null });
		this.stage.hidden = true;
		this.lobby.hidden = false;
		if (document.fullscreenElement === this.screenWrap) document.exitFullscreen?.().catch(() => {});
		this.renderRecent();
	}

	announce(to) {
		const game = this.game;
		if (!game?.emulator?.module) return;
		this.room.send(CH.NES, {
			type: 'game',
			title: game.rom.name,
			paused: game.emulator.paused,
			remote: typeof game.emulator.canvas?.captureStream === 'function',
			players: game.seats.seats.map(source => source && this.playerOf(game, source)),
		}, to);
	}

	/** A seat's player for the members: whose device, which of its pads, a name, and whether it's away. */
	playerOf(game, source) {
		const self = this.room.self;
		if (source === 'host') return { device: self.deviceId, pad: 0, name: self.name, away: false };
		if (source.startsWith('gp:')) return { device: self.deviceId, pad: Number(source.slice(3)) + 1, name: self.name, away: false };
		const who = game.who.get(source);
		return who ? { ...who, away: game.away.includes(source) } : null;
	}

	togglePause() {
		const emulator = this.game?.emulator;
		if (!emulator?.module) return;
		this.game.pausedFor = emulator.paused ? null : 'user';
		emulator.setPaused(!emulator.paused);
		this.renderNotice();
	}

	toggleMute() {
		this.prefs.muted = !this.prefs.muted;
		this.save();
		this.game?.emulator?.setMuted(this.prefs.muted);
		this.renderMute();
	}

	renderPause() {
		const game = this.game;
		const paused = Boolean(game?.emulator?.paused);
		this.pauseBtn.replaceChildren(icon(paused ? 'play' : 'pause'), paused ? 'Resume' : 'Pause');
		if (game?.touch) {
			game.touch.pauseBtn.replaceChildren(icon(paused ? 'play' : 'pause'), paused ? 'Resume' : 'Pause');
			game.touch.setHostName(this.touchLabel(game));
		}
		this.renderNotice();
	}

	// --- the host: a touch pad over its own picture ---

	touchLabel(game) {
		const names = game.away.map(source => game.names.get(source) ?? 'a player');
		if (!game.emulator?.paused) return game.rom.name;
		return game.pausedFor === 'away' && names.length ? `${game.rom.name} · waiting for ${names.join(', ')}` : `${game.rom.name} · paused`;
	}

	/** The NES pad over this device's own picture, full screen: this device plays with its fingers. */
	openTouchPad() {
		const game = this.game;
		if (!game?.emulator?.module || game.touch) return;
		game.emulator.unblockSound(); // a tap: the browser lets the sound start now
		const pauseBtn = h('button', { type: 'button', class: 'pad-top-btn text', onclick: () => this.togglePause() });
		const self = this.room.self;
		const play = new PadPlay(this.room, { peerId: self.peerId, name: game.rom.name, color: self.color }, {
			layout: 'nes',
			container: this.screenWrap,
			actions: [pauseBtn],
			sink: state => this.onTouch(game, state),
			onStop: () => {
				if (game.touch === play) game.touch = null;
				game.touchBits = 0;
				this.screenWrap.classList.remove('pad-on');
			},
		});
		play.pauseBtn = pauseBtn;
		game.touch = play;
		this.screenWrap.classList.add('pad-on'); // the picture fills the screen even where full screen isn't allowed
		this.renderPause();
	}

	onTouch(game, { buttons }) {
		const bits = nesBits(buttons);
		const pressed = bits & ~game.touchBits;
		game.touchBits = bits;
		if (!pressed) return;
		this.latch(game, 'host', pressed);
		game.emulator?.unblockSound();
	}

	renderMute() {
		this.muteBtn.replaceChildren(icon(this.prefs.muted ? 'volume-x' : 'volume'), this.prefs.muted ? 'Unmute' : 'Mute');
		this.muteBtn.setAttribute('aria-pressed', String(this.prefs.muted));
	}

	/** Over the picture: why it's paused, or that the browser holds the sound until a tap. */
	renderNotice() {
		const game = this.game;
		const emulator = game?.emulator;
		let text = '';
		if (emulator?.paused) {
			const names = game.away.map(source => game.names.get(source) ?? 'a player');
			text = game.pausedFor === 'away' && names.length ? `Paused: waiting for ${names.join(', ')}. Tap to go on without them.` : 'Paused. Tap to go on.';
		} else if (emulator?.soundBlocked) text = 'Tap for sound';
		this.notice.textContent = text;
		this.notice.hidden = !text;
	}

	onNotice() {
		const emulator = this.game?.emulator;
		if (!emulator) return;
		if (emulator.paused) this.togglePause();
		emulator.unblockSound();
	}

	// --- the host: players ---

	/** Members' pads that are here get a seat the first time; a seated one that went away pauses the game. */
	onPads() {
		const game = this.game;
		if (!game) return;
		for (const pad of this.hub.list()) {
			const source = `pad:${pad.index}`;
			game.names.set(source, `${pad.name}${pad.local ? ` (gamepad ${pad.local})` : ''}`);
			game.who.set(source, { device: pad.deviceId, pad: pad.local, name: pad.name });
			const want = pad.local === 0 ? game.wants.get(pad.deviceId) : undefined;
			if (want !== undefined) {
				game.wants.delete(pad.deviceId);
				this.takeSeat(game, source, want);
			}
			game.seats.arrive(source);
		}
		this.checkAway();
	}

	/** A member asked for a seat for its screen pad: it gets it if nobody has it. */
	onSeat(msg, member) {
		const game = this.game;
		if (!game || !Number.isInteger(msg.seat) || msg.seat < 0 || msg.seat >= PADS) return;
		game.wants.set(member.deviceId, msg.seat);
		this.onPads(); // takes it now if the pad is here, else when it arrives
		this.announce(member.peerId); // a refused request: the member sees who has the seat
	}

	takeSeat(game, source, seat) {
		const was = game.seats.seats[seat];
		if (was === null || was === source) game.seats.assign(seat, source);
	}

	checkAway() {
		const game = this.game;
		if (!game) return;
		game.away = game.seats.seats.filter(s => s?.startsWith('pad:') && !this.hub.pads.has(Number(s.slice(4))));
		const emulator = game.emulator;
		if (emulator?.module) {
			if (game.away.length && !emulator.paused) {
				game.pausedFor = 'away';
				emulator.setPaused(true);
			} else if (!game.away.length && game.pausedFor === 'away') {
				game.pausedFor = null;
				emulator.setPaused(false);
			}
		}
		this.hub.setSeats(new Map(game.seats.seats.flatMap((s, seat) => (s?.startsWith('pad:') ? [[Number(s.slice(4)), seat]] : []))));
		this.renderSeats();
		this.renderPause(); // the notice, and the touch pad's label
		this.announce();
	}

	/** The colour of whoever plays from a source. */
	colorOf(source) {
		if (!source) return '';
		if (!source.startsWith('pad:')) return this.room.self.color;
		const device = this.game?.who.get(source)?.device;
		return device ? memberColor(device) : '';
	}

	sourceLabel(source) {
		const game = this.game;
		if (source === 'host') return touchScreen() ? 'This device (touch pad, keys, gamepad)' : 'This device (keyboard, gamepad)';
		if (source.startsWith('gp:')) return `Gamepad ${Number(source.slice(3)) + 1} here`;
		const name = game?.names.get(source) ?? 'A member';
		return this.hub.pads.has(Number(source.slice(4))) ? name : `${name} (away)`;
	}

	renderSeats() {
		const game = this.game;
		if (!game) return;
		const sources = ['host',
			...localGamepads().filter(gp => gp.index > 0).map(gp => `gp:${gp.index}`),
			...this.hub.list().map(pad => `pad:${pad.index}`)];
		for (const s of game.seats.seats) if (s && !sources.includes(s)) sources.push(s);
		this.seatRows.forEach((row, i) => {
			const seated = game.seats.seats[i];
			row.select.replaceChildren(
				h('option', { value: '' }, 'Nobody'),
				...sources.map(source => h('option', { value: source }, this.sourceLabel(source))));
			row.select.value = seated ?? '';
			row.el.classList.toggle('away', game.away.includes(seated));
			row.el.classList.toggle('empty', !seated);
			row.el.style.setProperty('--member', this.colorOf(seated) || 'transparent');
		});
		this.seatNote.textContent = 'Players 3 and 4 need a game made for four (Four Score). Choosing someone who already plays swaps the two.';
	}

	latch(game, source, bits) {
		if (!bits || !game.emulator) return;
		const frames = game.emulator.frames;
		const held = game.latch.get(source);
		game.latch.set(source, { bits: (held && frames < held.until ? held.bits : 0) | bits, until: frames + TAP_FRAMES });
	}

	/** Before every frame: each seat's buttons to its NES pad. */
	applyInput(game) {
		const emulator = game.emulator;
		const frames = emulator.frames;
		const gamepads = localGamepads();
		for (const gp of gamepads) if (gp.index > 0 && !game.seats.known.has(`gp:${gp.index}`)) game.seats.arrive(`gp:${gp.index}`);
		const bitsOf = source => {
			let bits = 0;
			if (source === 'host') bits = game.keyBits | game.touchBits | gamepadBits(gamepads.find(gp => gp.index === 0));
			else if (source.startsWith('gp:')) bits = gamepadBits(gamepads.find(gp => gp.index === Number(source.slice(3))));
			else {
				const pad = this.hub.pads.get(Number(source.slice(4)));
				if (pad) bits = nesBits(pad.buttons, pad.axes);
			}
			const held = game.latch.get(source);
			if (held) {
				if (frames < held.until) bits |= held.bits;
				else game.latch.delete(source);
			}
			return bits;
		};
		game.seats.seats.forEach((source, i) => emulator.setPad(i, source ? bitsOf(source) : 0));
	}

	key(e) {
		const game = this.game;
		if (!game?.emulator?.module) return;
		const name = NES_BUTTONS.find(n => this.prefs.keys[n] === e.code);
		if (!name) return;
		if (e.type === 'keyup') {
			game.keyBits &= ~NES[name];
			return;
		}
		if (!this.ctx.visible() || typing(e.target) || document.querySelector('dialog[open]')) return;
		e.preventDefault();
		game.emulator.unblockSound();
		if (e.repeat) return;
		game.keyBits |= NES[name];
		this.latch(game, 'host', NES[name]);
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
				this.save();
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
			return h('label', { class: 'nes-seat' }, h('span', {}, name), btn);
		}));
		const dialog = openDialog(h('div', { class: 'sheet-body' },
			h('h2', {}, 'Keys'),
			h('p', { class: 'hint' }, 'The keys on this device for Player 1 (or whoever has "This device"). Tap a button, then press the key.'),
			list,
			h('div', { class: 'nes-row' },
				button('Defaults', 'undo', () => {
					this.prefs.keys = readKeys(null);
					this.save();
					render();
				}),
				button('Done', null, () => dialog.close(), 'btn small primary'))));
		window.addEventListener('keydown', capture, true);
		dialog.addEventListener('close', () => window.removeEventListener('keydown', capture, true));
		render();
		return dialog;
	}

	// --- the host: saves ---

	async loadSaves(game) {
		await this.libraryReady;
		if (!this.library || this.game !== game) return;
		game.saves = await this.library.saves(game.rom.hash).catch(() => new Map());
		this.renderSaves();
	}

	renderSaves() {
		const game = this.game;
		if (!game) return;
		if (!this.library) {
			this.saveRows.replaceChildren(h('p', { class: 'hint' }, 'This browser keeps nothing here: save with Export, and load the file with Import.'));
			return;
		}
		this.saveRows.replaceChildren(...Array.from({ length: SLOTS }, (_, i) => {
			const slot = i + 1;
			const saved = game.saves.get(slot);
			return h('div', { class: 'nes-save', 'data-slot': slot },
				h('span', {}, `Slot ${slot}`),
				h('span', { class: 'hint' }, saved ? timeAgo(saved.time) : 'empty'),
				button('Save', 'download', () => this.saveSlot(slot)),
				Object.assign(button('Load', 'upload', () => this.loadSlot(slot)), { disabled: !saved }));
		}));
	}

	async saveSlot(slot) {
		const game = this.game;
		const bytes = game?.emulator?.saveState();
		if (!bytes || !this.library) {
			toast('Could not save.');
			return;
		}
		try {
			await this.library.putSave(game.rom.hash, slot, bytes);
		} catch {
			toast('Could not save: the storage is full or blocked.');
			return;
		}
		game.saves.set(slot, { time: Date.now() });
		this.renderSaves();
		toast(`Saved in slot ${slot}`);
	}

	async loadSlot(slot) {
		const game = this.game;
		if (!game?.emulator) return;
		const bytes = await this.library?.save(game.rom.hash, slot).catch(() => null);
		if (bytes && game.emulator?.loadState(bytes)) toast(`Slot ${slot} loaded`);
		else toast('That save could not be loaded.');
	}

	exportState() {
		const game = this.game;
		const bytes = game?.emulator?.saveState();
		if (!bytes) return;
		download(bytes, `${game.rom.name}.fcs`);
	}

	async importState(file) {
		const emulator = this.game?.emulator;
		if (!file || !emulator) return;
		const bytes = file.size <= MAX_STATE ? new Uint8Array(await file.arrayBuffer()) : null;
		if (bytes && isState(bytes) && emulator.loadState(bytes)) toast('Save loaded');
		else toast('That isn’t an FCEUX save state.');
	}

	// --- the host: the picture for Remote play ---

	callViewer(peerId) {
		const game = this.game;
		if (!game?.emulator?.module || game.viewers.has(peerId)) return;
		const stream = game.emulator.captureStream();
		if (!stream) return;
		const call = this.room.call(peerId, stream, { kind: 'nes' }, { sdpTransform: musicSdp });
		if (!call) return;
		game.viewers.set(peerId, call);
		call.on('close', () => {
			if (game.viewers.get(peerId) === call) game.viewers.delete(peerId);
		});
	}

	onMessage(msg, member) {
		if (!member) return;
		if (msg?.type === 'game') this.onGame(msg, member);
		else if (msg?.type === 'seat') this.onSeat(msg, member);
		else if (msg?.type === 'watch' && this.game) {
			if (msg.on === true) {
				this.game.watchers.add(member.peerId);
				this.callViewer(member.peerId);
			} else {
				this.game.watchers.delete(member.peerId);
				this.game.viewers.get(member.peerId)?.close();
			}
		}
	}

	// --- a guest ---

	onGame(msg, member) {
		const game = readGame(msg);
		if (game === undefined) return;
		const isNew = game && !this.games.has(member.peerId);
		if (game === null) this.games.delete(member.peerId);
		else this.games.set(member.peerId, game);
		const guest = this.guest;
		if (guest?.host === member.peerId) {
			if (game === null) {
				toast(`${member.name} stopped the game`);
				guest.play.stop();
			} else this.renderGuest();
		}
		this.renderGames();
		if (isNew && !this.ctx.visible()) this.ctx.notify();
	}

	join(member, mode) {
		this.guest?.play.stop();
		const video = mode === 'remote' ? h('video', { class: 'nes-remote', autoplay: true, playsinline: true }) : null;
		if (video) video.playsInline = true;
		const guest = { host: member.peerId, mode, video, call: null, play: null, seats: null };
		this.guest = guest;
		guest.seatBtn = h('button', { type: 'button', class: 'pad-top-btn text', 'aria-haspopup': 'true', onclick: () => this.toggleSeats(guest) });
		guest.play = new PadPlay(this.room, member, { layout: 'nes', background: video, actions: [guest.seatBtn], onStop: () => this.leave(guest) });
		this.renderGuest();
		if (video) this.room.send(CH.NES, { type: 'watch', on: true }, member.peerId);
	}

	/** The pad's top bar: the host, the game, and which player this device is. */
	renderGuest() {
		const guest = this.guest;
		const host = guest && this.room.member(guest.host);
		if (!host) return;
		guest.play.setHostName(this.guestLabel(host));
		const players = this.games.get(guest.host)?.players ?? [];
		const seat = players.findIndex(p => this.playerInfo(p)?.mine);
		guest.seatBtn.textContent = seat === -1 ? 'Not playing' : `Player ${seat + 1}`;
		guest.seatBtn.setAttribute('aria-expanded', String(Boolean(guest.seats)));
		if (!guest.seats) return;
		guest.seats.replaceChildren(...Array.from({ length: PADS }, (_, i) => {
			const info = this.playerInfo(players[i]);
			return h('button', {
				type: 'button',
				class: `nes-player${info ? '' : ' free'}${info?.mine ? ' mine' : ''}`,
				style: info ? `--member: ${info.color}` : '',
				'data-seat': i,
				disabled: Boolean(info),
				'aria-current': info?.mine ? 'true' : null,
				onclick: () => this.askSeat(guest, i),
			}, h('span', { class: 'dot' }), `Player ${i + 1}`, h('span', { class: 'hint' }, info ? info.name : 'free'));
		}));
	}

	/** The seats over the pad: a free one can be taken. */
	toggleSeats(guest) {
		if (guest.seats) {
			guest.seats.remove();
			guest.seats = null;
		} else {
			guest.seats = h('div', { class: 'pad-seats', role: 'group', 'aria-label': 'Players' });
			guest.play.el.append(guest.seats);
		}
		this.renderGuest();
	}

	askSeat(guest, seat) {
		if (this.guest !== guest) return;
		this.room.send(CH.NES, { type: 'seat', seat }, guest.host);
		this.toggleSeats(guest);
	}

	leave(guest) {
		if (this.guest !== guest) return;
		this.guest = null;
		if (!guest.video) return;
		this.room.send(CH.NES, { type: 'watch', on: false }, guest.host);
		guest.call?.close();
		guest.video.srcObject = null;
	}

	onCall(call, member) {
		if (call.metadata?.kind !== 'nes') return; // voice and streams have their own
		const guest = this.guest;
		if (!guest?.video || member?.peerId !== guest.host) {
			call.close();
			return;
		}
		guest.call?.close();
		guest.call = call;
		call.on('stream', stream => {
			if (guest.video.srcObject === stream) return;
			guest.video.srcObject = stream;
			guest.video.play?.()?.catch?.(() => {});
		});
		call.on('close', () => {
			if (guest.call === call) guest.call = null;
		});
		call.answer(undefined, { sdpTransform: musicSdp }); // receive only
	}

	destroy() {
		this.stopGame();
		this.guest?.play.stop();
		for (const off of this.subs) off();
		window.removeEventListener('keydown', this.onKey);
		window.removeEventListener('keyup', this.onKey);
		window.removeEventListener('blur', this.onBlur);
	}
}
