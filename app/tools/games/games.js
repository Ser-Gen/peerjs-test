import { Emitter } from '../../emitter.js';
import { musicSdp } from '../../mediacall.js';
import { CH } from '../../protocol.js';
import { memberColor } from '../../room.js';
import { button, h, icon, toast } from '../../ui/dom.js';
import { wakeLock } from '../../util.js';
import nes from '../../games/nes/game.js';
import swing from '../../games/swing/game.js';
import { InputHub } from '../controller/input.js';
import { LAYOUTS, PadPlay, localGamepads } from '../controller/pad.js';
import { MAX_PLAYERS, Seats } from './seats.js';

const MAX_TITLE = 80;
const MAX_NAME = 40;

/*
 * The Games tool: a member runs a game on its device, and the others play it with their phones. It lists the games
 * running in the room and the ones this device can start (game modules, app/games/<id>/game.js), and does for every
 * game what they all need: the players (four seats; members' pads through the InputHub, which this device holds while
 * a game runs), pausing while a player is away, the picture for Remote play, and a guest's pad in the layout the game
 * asks for.
 *
 * A game module:
 *   { id, title, about, layout: 'nes'|'motion', players: {min, max}, thisDevice, wrapClass?, supported(),
 *     lobby?({start}) → {el, refresh?()},            what "Play here" shows for it (default: a Start button)
 *     mount(session, options) → game }               runs it; `options` is what its lobby passed to start()
 *   `layout` is the pad the guests get. `thisDevice`: this device plays too (its keys, screen and gamepads are the
 *   source 'host', Player 1 at first); without it only members' pads take seats.
 * The game it returns: { title, el?, toolbar?, panels?, playersExtra?, playersNote?, hostLabel?, start?(),
 *   setPaused?(on), notice?() → text, tap?(), canStream?(), stream?(), destroy() }. Its `el` goes in the picture's
 *   place, and then start() is called: it resolves once the game runs (a rejection's message is shown, and the game
 *   stops).
 * The Session it gets: `room`, `seats`, `wrap` (the picture's box), `paused`, `togglePause()`, `pad(source)` (a
 * member's pad as the InputHub has it), `name(source)`, `color(source)`, `status()`, `visible()`, `changed()`,
 * `restream()`, `stop()`, and the events 'press' (source, button), 'state' (source: a member's pad changed), 'status'
 * (paused, or who is away) and 'seats'.
 *
 * Protocol (ch: 'games'); the pads themselves are ch 'input' (app/tools/controller/input.js):
 *   game  {game, title, layout, paused, remote, players}
 *                                   host → members: a game runs (on start, on every change, on link up); title
 *                                   null: it stopped. `game` is the module's id, `layout` the pad to use, `remote`:
 *                                   the picture can be streamed. `players`: the seats, each null or {device, pad,
 *                                   name, away}: whose device (its ID, so a reload keeps it), which of its pads (0
 *                                   its screen or keys, n its gamepad n), the name the host knows and whether that
 *                                   pad is gone for now.
 *   watch {on}                      guest → host: send me the picture (a media call, metadata {kind: 'game'}) or stop
 *   seat  {seat}                    guest → host: put my screen pad on this seat if it's free
 * A seated member's pad that goes away pauses the game, and it goes on when the pad comes back.
 */

export const GAMES = [nes, swing];

export default {
	id: 'games',
	title: 'Games',
	supported: () => typeof RTCPeerConnection === 'function' && GAMES.some(game => game.supported()),
	mount(el, room, ctx) {
		const tool = new GamesTool(el, room, ctx);
		return () => tool.destroy();
	},
};

const clean = (text, max) => (typeof text === 'string' ? text.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max) : '');

/** A `game` message: {game, title, layout, paused, remote, players}, null for a stopped game, undefined for one that isn't valid. */
export function readGame(msg) {
	if (msg?.title === null) return null;
	const title = clean(msg?.title, MAX_TITLE);
	if (!title) return undefined;
	return {
		game: typeof msg.game === 'string' && /^[a-z0-9-]{1,24}$/.test(msg.game) ? msg.game : null,
		title,
		layout: Object.hasOwn(LAYOUTS, msg.layout) ? msg.layout : 'nes',
		paused: msg.paused === true,
		remote: msg.remote === true,
		players: readPlayers(msg.players),
	};
}

/** The seats of a `game` message (four when it doesn't say); a seat that isn't valid is empty. */
export function readPlayers(raw) {
	const count = Array.isArray(raw) && raw.length ? Math.min(raw.length, MAX_PLAYERS) : MAX_PLAYERS;
	return Array.from({ length: count }, (_, i) => {
		const p = Array.isArray(raw) ? raw[i] : null;
		if (!p || typeof p !== 'object') return null;
		if (typeof p.device !== 'string' || !/^[0-9a-f]{8,64}$/.test(p.device)) return null;
		if (!Number.isInteger(p.pad) || p.pad < 0 || p.pad > 4) return null;
		return { device: p.device, pad: p.pad, name: clean(p.name, MAX_NAME) || 'A player', away: p.away === true };
	});
}

const touchScreen = () => matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
const seatOfSlot = source => Number(source.slice(4)); // 'pad:<n>' → n

/** What a game module gets from the tool while it runs. */
class Session extends Emitter {
	constructor(tool, game) {
		super();
		this.tool = tool;
		this.game = game;
		this.room = tool.room;
		this.seats = game.seats;
		this.wrap = tool.screenWrap;
	}

	get paused() {
		return this.game.paused;
	}

	get running() {
		return this.tool.game === this.game;
	}

	visible() {
		return this.tool.ctx.visible();
	}

	togglePause() {
		if (this.running) this.tool.togglePause();
	}

	/** A member's pad ('pad:<n>') as the InputHub keeps it ({buttons (a mask), axes, quat, t (the sender's clock), at,
	 * name, …}), or null while it's away. */
	pad(source) {
		return source?.startsWith('pad:') ? this.tool.hub.pads.get(seatOfSlot(source)) ?? null : null;
	}

	name(source) {
		return this.tool.sourceName(this.game, source);
	}

	color(source) {
		return this.tool.colorOf(source);
	}

	/** The game's title with "paused" or who it waits for. */
	status() {
		return this.tool.statusLabel(this.game);
	}

	/** Something the room or the picture shows changed (the sound, whether it can be streamed). */
	changed() {
		if (!this.running) return;
		this.tool.renderNotice();
		this.tool.announce();
	}

	/** The picture is a new one (the game started again): Remote play gets it anew. */
	restream() {
		if (this.running) this.tool.restream(this.game);
	}

	stop() {
		if (this.running) this.tool.stopGame();
	}
}

class GamesTool {
	constructor(el, room, ctx) {
		this.el = el;
		this.room = room;
		this.ctx = ctx;
		this.hub = InputHub.of(room);
		this.games = new Map(); // peer ID → the game it runs, as readGame gives it
		this.game = null; // the game this device runs
		this.guest = null; // this device as a pad for someone's game

		this.subs = [
			room.on(`msg:${CH.GAMES}`, (msg, member) => this.onMessage(msg, member)),
			room.on('link-up', member => {
				if (this.game?.ready) this.announce(member.peerId);
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
			this.hub.on('press', (slot, index) => this.game?.session.emit('press', `pad:${slot}`, index)),
			this.hub.on('state', slot => this.game?.session.emit('state', `pad:${slot}`)),
		];

		el.classList.add('games');
		this.lobby = this.buildLobby();
		this.stage = this.buildStage();
		el.append(h('div', { class: 'games-body' }, this.lobby, this.stage));
		this.renderGames();
	}

	// --- the lobby: the others' games, and the games this device can run ---

	buildLobby() {
		this.gameList = h('div', { class: 'games-list' });
		this.gamesSection = h('section', { class: 'games-section' }, h('h3', {}, 'Games in this room'), this.gameList);
		this.lobbies = GAMES.filter(game => game.supported()).map(game => {
			const start = options => this.startGame(game, options);
			const lobby = game.lobby?.({ start }) ?? { el: button('Start', 'play', () => start(), 'btn primary') };
			const players = game.players.min === game.players.max ? `${game.players.max}` : `${game.players.min}–${game.players.max}`;
			lobby.section = h('section', { class: 'games-section games-module', 'data-game': game.id },
				h('h3', {}, `${game.title} · ${players} players`),
				h('p', { class: 'hint' }, game.about),
				lobby.el);
			return lobby;
		});
		return h('div', { class: 'games-lobby' },
			this.gamesSection,
			h('h2', { class: 'games-heading' }, 'Play here'),
			...this.lobbies.map(lobby => lobby.section));
	}

	guestLabel(member, game = this.games.get(member.peerId)) {
		return `${member.name}${game ? ` · ${game.title}` : ''}${game?.paused ? ' · paused' : ''}`;
	}

	renderGames() {
		const rows = this.room.members.filter(m => this.games.has(m.peerId)).map(member => {
			const game = this.games.get(member.peerId);
			const kind = GAMES.find(g => g.id === game.game);
			return h('div', { class: 'games-game', style: `--member: ${member.color}`, 'data-peer': member.peerId },
				h('span', { class: 'dot' }),
				h('div', { class: 'games-text' },
					h('strong', {}, game.title),
					h('span', { class: 'hint' }, `${member.name}${kind && kind.title !== game.title ? ` · ${kind.title}` : ''}${game.paused ? ' · paused' : ''}`)),
				button('Join', 'gamepad', () => this.join(member, 'pad'), 'btn small'),
				game.remote ? button('Remote play', 'monitor', () => this.join(member, 'remote'), 'btn small') : null,
				h('div', { class: 'games-players' }, ...game.players.map((player, i) => this.playerChip(player, i))));
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
			class: `games-player${info ? '' : ' free'}${player?.away ? ' away' : ''}${info?.mine ? ' mine' : ''}`,
			style: info ? `--member: ${info.color}` : '',
			'data-seat': seat,
		}, h('span', { class: 'dot' }), `${seat + 1} ${info ? info.name : 'free'}${player?.away ? ' (away)' : ''}`);
	}

	// --- the host: running a game ---

	buildStage() {
		this.notice = h('button', { type: 'button', class: 'games-notice', hidden: true, onclick: () => this.onNotice() });
		this.screenWrap = h('div', { class: 'games-screen-wrap', onpointerdown: () => this.game?.instance?.tap?.() });
		this.titleEl = h('strong', { class: 'games-title' });
		this.extraTools = h('span', { class: 'games-tools' });
		this.pauseBtn = h('button', { type: 'button', class: 'btn small', onclick: () => this.togglePause() });
		const toolbar = h('div', { class: 'games-toolbar' },
			this.titleEl,
			this.extraTools,
			this.pauseBtn,
			button('Full screen', 'maximize', () => this.screenWrap.requestFullscreen?.().catch(() => {})),
			button('Stop', 'stop', () => this.stopGame(), 'btn small danger'));
		this.seatList = h('div', { class: 'games-seats' });
		this.seatNote = h('p', { class: 'hint' });
		this.playersExtra = h('div', { class: 'games-row' });
		this.panels = h('div', { class: 'games-panels' });
		return h('div', { class: 'games-stage', hidden: true },
			toolbar,
			this.screenWrap,
			this.panels);
	}

	async startGame(kind, options = {}) {
		this.stopGame();
		this.guest?.play.stop();
		const game = (this.game = {
			kind,
			instance: null,
			ready: false,
			paused: false,
			pausedFor: null, // 'user' | 'away'
			seats: new Seats(kind.players.max, { host: kind.thisDevice }),
			watchers: new Set(), // members that asked for the picture
			viewers: new Map(), // peer ID → the media call that sends it
			away: [],
			names: new Map(), // source → who it is, kept while it's away
			who: new Map(), // source 'pad:<n>' → {device, pad, name}, for the players in `game`, kept while it's away
			wants: new Map(), // device ID → the seat its member asked for before its pad arrived
			release: this.hub.take(),
		});
		game.session = new Session(this, game);
		game.seats.on('change', () => {
			this.checkAway();
			game.session.emit('seats');
		});
		this.screenWrap.className = `games-screen-wrap${kind.wrapClass ? ` ${kind.wrapClass}` : ''}`;
		this.screenWrap.replaceChildren(this.notice);
		this.lobby.hidden = true;
		this.stage.hidden = false;
		wakeLock.acquire();
		let instance;
		try {
			instance = kind.mount(game.session, options);
		} catch (err) {
			toast(err?.message || 'The game could not start.');
			this.stopGame();
			return;
		}
		game.instance = instance;
		if (instance.el) this.screenWrap.prepend(instance.el);
		this.titleEl.textContent = instance.title;
		this.extraTools.replaceChildren(...(instance.toolbar ?? []));
		this.playersExtra.replaceChildren(...(instance.playersExtra ?? []));
		this.seatNote.textContent = [instance.playersNote, game.seats.seats.length > 1 ? 'Choosing someone who already plays swaps the two.' : '']
			.filter(Boolean).join(' ');
		this.buildSeats(game);
		this.panels.replaceChildren(
			h('section', { class: 'games-section' }, h('h3', {}, 'Players'), this.seatList, this.seatNote, this.playersExtra),
			...(instance.panels ?? []));
		this.renderSeats();
		this.renderPause();
		try {
			await instance.start?.();
		} catch (err) {
			if (this.game !== game) return;
			toast(err?.message || 'The game could not start.');
			this.stopGame();
			return;
		}
		if (this.game !== game) return;
		game.ready = true;
		this.onPads();
		this.announce();
		this.restream(game);
	}

	stopGame() {
		const game = this.game;
		if (!game) return;
		this.game = null;
		game.instance?.destroy();
		for (const call of game.viewers.values()) call.close();
		game.release();
		this.hub.setSeats(null);
		wakeLock.release();
		this.room.send(CH.GAMES, { type: 'game', title: null });
		this.stage.hidden = true;
		this.lobby.hidden = false;
		if (document.fullscreenElement === this.screenWrap) document.exitFullscreen?.().catch(() => {});
		this.screenWrap.replaceChildren(this.notice);
		for (const lobby of this.lobbies) lobby.refresh?.();
	}

	announce(to) {
		const game = this.game;
		if (!game?.ready) return;
		this.room.send(CH.GAMES, {
			type: 'game',
			game: game.kind.id,
			title: game.instance.title,
			layout: game.kind.layout,
			paused: game.paused,
			remote: Boolean(game.instance.canStream?.()),
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

	setPaused(game, paused, why) {
		game.pausedFor = paused ? why : null;
		if (game.paused === paused) return;
		game.paused = paused;
		game.instance?.setPaused?.(paused);
		this.renderPause();
		game.session.emit('status');
		this.announce();
	}

	togglePause() {
		const game = this.game;
		if (!game?.ready) return;
		this.setPaused(game, !game.paused, 'user');
	}

	statusLabel(game) {
		const title = game.instance?.title ?? game.kind.title;
		if (!game.paused) return title;
		const names = game.away.map(source => game.names.get(source) ?? 'a player');
		return game.pausedFor === 'away' && names.length ? `${title} · waiting for ${names.join(', ')}` : `${title} · paused`;
	}

	renderPause() {
		const paused = Boolean(this.game?.paused);
		this.pauseBtn.replaceChildren(icon(paused ? 'play' : 'pause'), paused ? 'Resume' : 'Pause');
		this.renderNotice();
	}

	/** Over the picture: why it's paused, or what the game has to say (the sound waiting for a tap). */
	renderNotice() {
		const game = this.game;
		let text = '';
		if (game?.paused) {
			const names = game.away.map(source => game.names.get(source) ?? 'a player');
			text = game.pausedFor === 'away' && names.length ? `Paused: waiting for ${names.join(', ')}. Tap to go on without them.` : 'Paused. Tap to go on.';
		} else if (game?.ready) text = game.instance.notice?.() ?? '';
		this.notice.textContent = text;
		this.notice.hidden = !text;
	}

	onNotice() {
		const game = this.game;
		if (!game) return;
		if (game.paused) this.togglePause();
		game.instance?.tap?.();
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
		if (!game || !Number.isInteger(msg.seat) || msg.seat < 0 || msg.seat >= game.seats.seats.length) return;
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
		game.away = game.seats.seats.filter(s => s?.startsWith('pad:') && !this.hub.pads.has(seatOfSlot(s)));
		if (game.away.length && !game.paused) this.setPaused(game, true, 'away');
		else if (!game.away.length && game.pausedFor === 'away') this.setPaused(game, false);
		this.hub.setSeats(new Map(game.seats.seats.flatMap((s, seat) => (s?.startsWith('pad:') ? [[seatOfSlot(s), seat]] : []))));
		this.renderSeats();
		this.renderPause(); // the notice
		game.session.emit('status');
		this.announce();
	}

	/** The colour of whoever plays from a source. */
	colorOf(source) {
		if (!source) return '';
		if (!source.startsWith('pad:')) return this.room.self.color;
		const device = this.game?.who.get(source)?.device;
		return device ? memberColor(device) : '';
	}

	/** Who plays from a source, for people. */
	sourceName(game, source) {
		if (source === 'host') return this.room.self.name;
		if (source.startsWith('gp:')) return `Gamepad ${Number(source.slice(3)) + 1} here`;
		return game.names.get(source) ?? 'A member';
	}

	sourceLabel(source) {
		const game = this.game;
		if (source === 'host') return game.instance?.hostLabel ?? 'This device';
		if (source.startsWith('gp:')) return `Gamepad ${Number(source.slice(3)) + 1} here`;
		const name = this.sourceName(game, source);
		return this.hub.pads.has(seatOfSlot(source)) ? name : `${name} (away)`;
	}

	buildSeats(game) {
		this.seatRows = game.seats.seats.map((_, i) => {
			const select = h('select', { 'aria-label': `Player ${i + 1}`, onchange: () => this.game?.seats.assign(i, select.value || null) });
			return { select, el: h('label', { class: 'games-seat' }, h('span', { class: 'dot' }), h('span', {}, `Player ${i + 1}`), select) };
		});
		this.seatList.replaceChildren(...this.seatRows.map(row => row.el));
	}

	renderSeats() {
		const game = this.game;
		if (!game || !this.seatRows) return;
		const sources = [
			...(game.kind.thisDevice ? ['host', ...localGamepads().filter(gp => gp.index > 0).map(gp => `gp:${gp.index}`)] : []),
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
	}

	// --- the host: the picture for Remote play ---

	/** Remote play gets the game's picture: now, or again when it's a new one (a Reset). */
	restream(game) {
		for (const call of game.viewers.values()) call.close();
		game.viewers.clear();
		for (const peerId of game.watchers) this.callViewer(peerId);
	}

	callViewer(peerId) {
		const game = this.game;
		if (!game?.ready || game.viewers.has(peerId)) return;
		const stream = game.instance.stream?.();
		if (!stream) return;
		const call = this.room.call(peerId, stream, { kind: 'game' }, { sdpTransform: musicSdp });
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
		const before = this.games.get(member.peerId);
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
		if (game && !before && !this.ctx.visible()) this.ctx.notify();
	}

	join(member, mode) {
		const game = this.games.get(member.peerId);
		if (!game) return;
		this.guest?.play.stop();
		const remote = mode === 'remote' && game.remote;
		const video = remote ? h('video', { class: 'games-remote', autoplay: true, playsinline: true }) : null;
		if (video) video.playsInline = true;
		const guest = { host: member.peerId, mode, video, call: null, play: null, seats: null };
		this.guest = guest;
		guest.seatBtn = h('button', { type: 'button', class: 'pad-top-btn text', 'aria-haspopup': 'true', onclick: () => this.toggleSeats(guest) });
		guest.play = new PadPlay(this.room, member, { layout: game.layout, background: video, actions: [guest.seatBtn], onStop: () => this.leave(guest) });
		this.renderGuest();
		if (video) this.room.send(CH.GAMES, { type: 'watch', on: true }, member.peerId);
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
		guest.seats.replaceChildren(...players.map((player, i) => {
			const info = this.playerInfo(player);
			return h('button', {
				type: 'button',
				class: `games-player${info ? '' : ' free'}${info?.mine ? ' mine' : ''}`,
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
		this.room.send(CH.GAMES, { type: 'seat', seat }, guest.host);
		this.toggleSeats(guest);
	}

	leave(guest) {
		if (this.guest !== guest) return;
		this.guest = null;
		if (!guest.video) return;
		this.room.send(CH.GAMES, { type: 'watch', on: false }, guest.host);
		guest.call?.close();
		guest.video.srcObject = null;
	}

	onCall(call, member) {
		if (call.metadata?.kind !== 'game') return; // voice and streams have their own
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
		for (const lobby of this.lobbies) lobby.destroy?.();
	}
}
