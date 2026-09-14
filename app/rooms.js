import { cleanName } from './device.js';
import { Emitter } from './emitter.js';
import { TOKEN_RE } from './protocol.js';
import { decodeProfile, encodeProfile, isPublic, normalizeProfile, serverKey } from './settings.js';
import { decodeTurn, encodeTurn, parseGuestTurn } from './turn.js';
import { randomId, randomInt, readJSON, writeJSON } from './util.js';

const ROOMS_KEY = 'peerkit.rooms';
const RECENT_KEY = 'peerkit.recent';
const VERSION = 1;
const MAX_TRUSTED = 5;
const MAX_RECENT = 10;

const CODE_RE = /^[a-z]{2,12}-\d{2,4}$/;

// Short words that are easy to say and type. A code is word-NN: about 12 000 codes per server.
const WORDS = `
	ant bat bear bee bird boar bull cat clam cod colt crab crow deer dog dove duck eagle eel elk emu
	finch fish fox frog gecko goat goose hare hawk heron horse ibis koala lamb lark lion llama lynx mole
	moose moth mouse mule newt otter owl panda pig pony puma quail ram raven robin seal shark sheep skunk
	sloth snail snake squid stork swan tiger toad trout tuna wasp whale wolf worm yak zebra
	acorn apple bean berry cake cedar cherry cloud comet coral corn daisy dune ember fern fig flame frost
	grape hill honey iris jade kite lake leaf lemon lily lime mango maple melon mint moon oak olive onion
	orbit peach pear pearl pine plum rain river rock rose ruby sand snow star stone storm sun tulip wave
	wind wood
`.trim().split(/\s+/);

/** The host's peer ID. The prefix keeps PeerKit apart from other apps on a shared server. */
export const hostPeerId = code => `pk-${code}`;

/** "Fox 42", "FOX-42" or "fox42" → "fox-42"; null if it isn't a room code. */
export function parseRoomCode(input) {
	const match = String(input ?? '').trim().toLowerCase().match(/^([a-z]{2,12})[\s_-]*(\d{2,4})$/);
	return match ? `${match[1]}-${match[2]}` : null;
}

// --- links: #join=<code>&t=<token>&s=<server>&r=<TURN credentials> ---

export function joinLink({ code, token = null, profile, turn = null }) {
	let hash = `join=${code}`;
	if (token) hash += `&t=${token}`;
	// The public server is the default on both ends, so leaving it out keeps the QR small.
	if (!isPublic(profile)) hash += `&s=${encodeProfile(profile)}`;
	// Temporary credentials only; the secret never goes into a link.
	if (turn) hash += `&r=${encodeTurn(turn)}`;
	return `${location.origin}${location.pathname}#${hash}`;
}

/** `{ isJoin: false }` for a host page, otherwise `{ isJoin: true, code, token, profile, turn, error }`. */
export function parseLink(hash) {
	const params = new URLSearchParams(String(hash ?? '').replace(/^#/, ''));
	if (!params.has('join')) return { isJoin: false, code: null, token: null, profile: null, turn: null, error: null };
	const code = parseRoomCode(params.get('join'));
	const token = TOKEN_RE.test(params.get('t') ?? '') ? params.get('t') : null;
	// Damaged or expired credentials don't break the link: the host's relay usually still works.
	const turn = params.has('r') ? decodeTurn(params.get('r')) : null;
	const link = { isJoin: true, code, token, profile: null, turn, error: null };
	if (!code) return { ...link, error: 'invalid-id' };
	if (!params.has('s')) return link;
	try {
		return { ...link, profile: decodeProfile(params.get('s')) };
	} catch (err) {
		console.warn('[peerkit] bad server settings in link:', err.message);
		return { ...link, error: 'bad-link' };
	}
}

// --- host: one permanent room per server ---

let roomsFallback = null; // used when storage is blocked, so the code at least lasts this page

function loadRooms() {
	const raw = readJSON(ROOMS_KEY);
	if (raw?.version === VERSION && raw.rooms && typeof raw.rooms === 'object' && !Array.isArray(raw.rooms)) return raw;
	return roomsFallback ?? { version: VERSION, rooms: {} };
}

function saveRooms(data) {
	if (!writeJSON(ROOMS_KEY, data)) roomsFallback = data;
}

const validRoom = room => Boolean(room) && CODE_RE.test(room.code) && TOKEN_RE.test(room.token) && Array.isArray(room.guests);

const newRoom = () => ({ code: `${WORDS[randomInt(WORDS.length)]}-${10 + randomInt(90)}`, token: randomId(6), guests: [] });

/** Host side: a room code and link token per server, plus the devices it already let in. */
export const rooms = {
	get(profile) {
		const data = loadRooms();
		const key = serverKey(profile);
		if (!validRoom(data.rooms[key])) {
			data.rooms[key] = newRoom();
			saveRooms(data);
		}
		return data.rooms[key];
	},

	/** New code and token; old links, QR codes and remembered devices stop working. */
	regenerate(profile) {
		const data = loadRooms();
		data.rooms[serverKey(profile)] = newRoom();
		saveRooms(data);
	},

	isTrusted(profile, deviceId) {
		return Boolean(deviceId) && this.get(profile).guests.some(guest => guest?.id === deviceId);
	},

	trust(profile, { deviceId, name }) {
		if (!deviceId) return;
		const data = loadRooms();
		const room = data.rooms[serverKey(profile)];
		if (!validRoom(room)) return;
		room.guests = [{ id: deviceId, name }, ...room.guests.filter(guest => guest?.id !== deviceId)].slice(0, MAX_TRUSTED);
		saveRooms(data);
	},
};

// --- guest: hosts it connected to ---

const entryKey = (profile, code) => `${code}@${serverKey(profile)}`;

function parseEntry(raw) {
	const code = parseRoomCode(raw?.code);
	if (!code) return null;
	let profile;
	try {
		profile = normalizeProfile(raw.profile);
	} catch {
		return null;
	}
	return {
		key: entryKey(profile, code),
		code,
		token: TOKEN_RE.test(raw.token) ? raw.token : null,
		name: cleanName(raw.name) || code,
		profile,
		turn: parseGuestTurn(raw.turn),
		lastSeen: Number.isFinite(raw.lastSeen) ? raw.lastSeen : 0,
	};
}

/** Emits 'change'. */
class RecentHosts extends Emitter {
	constructor() {
		super();
		window.addEventListener('storage', e => {
			if (e.key === RECENT_KEY) this.emit('change');
		});
	}

	/** Newest first: `{ key, code, token, name, profile, turn, lastSeen }`. */
	list() {
		const raw = readJSON(RECENT_KEY);
		if (raw?.version !== VERSION || !Array.isArray(raw.hosts)) return [];
		return raw.hosts.map(parseEntry).filter(Boolean).sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_RECENT);
	}

	find(profile, code) {
		const key = entryKey(profile, code);
		return this.list().find(entry => entry.key === key) ?? null;
	}

	touch({ code, token, name, profile, turn = null }) {
		const key = entryKey(profile, code);
		const previous = this.list();
		const before = previous.find(e => e.key === key);
		const entry = {
			code,
			token: token ?? before?.token ?? null,
			name: cleanName(name) || code,
			profile: normalizeProfile(profile),
			turn: turn ?? before?.turn ?? null,
			lastSeen: Date.now(),
		};
		this._save([entry, ...previous.filter(e => e.key !== key)]);
	}

	remove(key) {
		this._save(this.list().filter(entry => entry.key !== key));
	}

	_save(entries) {
		const hosts = entries.slice(0, MAX_RECENT).map(({ key, ...entry }) => entry);
		writeJSON(RECENT_KEY, { version: VERSION, hosts });
		this.emit('change');
	}
}

export const recentHosts = new RecentHosts();
