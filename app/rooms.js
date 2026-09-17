import { WORDS } from '../vendor/words.js';
import { hmac, sha256, toHex } from './crypto.js';
import { cleanName } from './device.js';
import { Emitter } from './emitter.js';
import { decodeProfile, encodeProfile, isPublic, normalizeProfile } from './settings.js';
import { decodeTurn, encodeTurn, parseGuestTurn } from './turn.js';
import { randomInt, readJSON, writeJSON } from './util.js';

const STORE_KEY = 'peerkit.room';
const VERSION = 1;
const MAX_RECENT = 10;
const MAX_NAMES = 6;
const CODE_WORDS = 4;
// Keys of the host/guest model before rooms (Slice 6 and earlier); only checked for the one-time notice.
const LEGACY_KEYS = ['peerkit.rooms', 'peerkit.recent'];

/*
 * A room is its code: 4 words from the BIP-39 list (about 44 bits), e.g. "amber-otter-quiet-lamp".
 * Everything else is derived from it with SHA-256 under its own label:
 *   id        storage key for the room's data (documents…)
 *   anchorId  the well-known peer ID newcomers connect to, so the signaling server never sees the code
 *   key       HMAC key that members use to prove to each other that they know the code
 */

const CODE_RE = /^[a-z]{3,8}(?:-[a-z]{3,8}){3}$/;
const WORD_SET = new Set(WORDS);
// BIP-39 words differ in their first 4 letters, so 4 letters are enough to type a word.
const BY_PREFIX = new Map(WORDS.map(word => [word.slice(0, 4), word]));

export function newRoomCode() {
	return Array.from({ length: CODE_WORDS }, () => WORDS[randomInt(WORDS.length)]).join('-');
}

/** "Amber otter QUIET lamp", "ambe-otte-quie-lamp" → "amber-otter-quiet-lamp"; null if it isn't a room code. */
export function parseRoomCode(input) {
	const parts = String(input ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
	if (parts.length !== CODE_WORDS) return null;
	const words = parts.map(part => {
		if (WORD_SET.has(part)) return part;
		if (part.length < 4) return null;
		const word = BY_PREFIX.get(part.slice(0, 4));
		return word?.startsWith(part) ? word : null;
	});
	return words.every(Boolean) ? words.join('-') : null;
}

export const isRoomCode = code => typeof code === 'string' && CODE_RE.test(code) && code.split('-').every(word => WORD_SET.has(word));

const derived = new Map();

/** `{ id, anchorId, key }` of a room code. */
export function roomIds(code) {
	let ids = derived.get(code);
	if (!ids) {
		ids = {
			id: toHex(sha256(`peerkit/room-id\n${code}`)).slice(0, 32),
			anchorId: `pk-${toHex(sha256(`peerkit/anchor\n${code}`)).slice(0, 32)}`,
			key: sha256(`peerkit/room-key\n${code}`),
		};
		derived.set(code, ids);
	}
	return ids;
}

/** Proof that the sender knows the room code, bound to this one connection. */
export function roomProof(key, fields) {
	return toHex(hmac(key, fields.join('\n')));
}

// --- links: #room=<code>&s=<server>&r=<TURN credentials> ---

export function roomLink({ code, profile, turn = null }) {
	let hash = `room=${code}`;
	// The public server is the default on both ends, so leaving it out keeps the QR small.
	if (!isPublic(profile)) hash += `&s=${encodeProfile(profile)}`;
	// Temporary credentials only; the secret never goes into a link.
	if (turn) hash += `&r=${encodeTurn(turn)}`;
	return `${location.origin}${location.pathname}#${hash}`;
}

/**
 * `{ kind: 'none' }`, `{ kind: 'legacy' }` for an old #join= pairing link, or
 * `{ kind: 'room', code, profile, turn, error }` (profile null = the public server).
 */
export function parseLink(hash) {
	const params = new URLSearchParams(String(hash ?? '').replace(/^#/, ''));
	if (params.has('join')) return { kind: 'legacy' };
	if (!params.has('room')) return { kind: 'none' };
	const code = parseRoomCode(params.get('room'));
	// Damaged or expired credentials don't break the link: another member's relay usually still works.
	const turn = params.has('r') ? decodeTurn(params.get('r')) : null;
	const link = { kind: 'room', code, profile: null, turn, error: null };
	if (!code) return { ...link, error: 'invalid-code' };
	if (!params.has('s')) return link;
	try {
		return { ...link, profile: decodeProfile(params.get('s')) };
	} catch (err) {
		console.warn('[peerkit] bad server settings in link:', err.message);
		return { ...link, error: 'bad-link' };
	}
}

// --- storage: the open room and recent rooms ---

function parseEntry(raw) {
	if (!isRoomCode(raw?.code)) return null;
	let profile;
	try {
		profile = normalizeProfile(raw.profile);
	} catch {
		return null;
	}
	return {
		code: raw.code,
		profile,
		turn: parseGuestTurn(raw.turn),
		names: Array.isArray(raw.names) ? raw.names.map(name => cleanName(name)).filter(Boolean).slice(0, MAX_NAMES) : [],
		lastSeen: Number.isFinite(raw.lastSeen) ? raw.lastSeen : 0,
		known: raw.known === true, // this device made the room or has been in it
	};
}

let fallback = null; // used when storage is blocked, so the room at least lasts this page

/** The room this device is in (`current`, a code or null) and the rooms it was in. Emits 'change'. */
class RoomStore extends Emitter {
	constructor() {
		super();
		window.addEventListener('storage', e => {
			if (e.key === STORE_KEY) this.emit('change');
		});
	}

	_load() {
		const raw = readJSON(STORE_KEY);
		if (raw?.version !== VERSION || !Array.isArray(raw.rooms)) return fallback ?? { version: VERSION, current: null, rooms: [] };
		const rooms = raw.rooms.map(parseEntry).filter(Boolean);
		const current = rooms.some(room => room.code === raw.current) ? raw.current : null;
		return { version: VERSION, current, rooms };
	}

	_save(data) {
		const next = { ...data, rooms: data.rooms.slice(0, MAX_RECENT) };
		if (!writeJSON(STORE_KEY, next)) fallback = next;
		this.emit('change');
	}

	/** The open room's entry, or null. */
	get current() {
		const data = this._load();
		return data.rooms.find(room => room.code === data.current) ?? null;
	}

	/** Rooms newest first: `{ code, profile, turn, names, lastSeen, known }`. */
	list() {
		return this._load().rooms.sort((a, b) => b.lastSeen - a.lastSeen);
	}

	find(code) {
		return this.list().find(room => room.code === code) ?? null;
	}

	/** Make a room the open one. Keeps what is known about it unless given anew. */
	open({ code, profile, turn = null, known = false }) {
		const data = this._load();
		const before = data.rooms.find(room => room.code === code);
		const entry = {
			code,
			profile: normalizeProfile(profile),
			turn: turn ?? before?.turn ?? null,
			names: before?.names ?? [],
			lastSeen: Date.now(),
			known: known || before?.known === true,
		};
		this._save({ ...data, current: code, rooms: [entry, ...data.rooms.filter(room => room.code !== code)] });
		return entry;
	}

	/** Remember that the room was open here, who was in it and the newest TURN credentials. */
	update(code, { names = null, turn = null, known = false }) {
		const data = this._load();
		const entry = data.rooms.find(room => room.code === code);
		if (!entry) return;
		if (names) entry.names = [...new Set([...names, ...entry.names])].slice(0, MAX_NAMES);
		if (turn) entry.turn = turn;
		if (known) entry.known = true;
		entry.lastSeen = Date.now();
		this._save(data);
	}

	/** Close the open room; it stays in the list. */
	leave() {
		this._save({ ...this._load(), current: null });
	}

	forget(code) {
		const data = this._load();
		this._save({ ...data, current: data.current === code ? null : data.current, rooms: data.rooms.filter(room => room.code !== code) });
	}

	/** This browser has data from the host/guest model, and no rooms yet. */
	get hasLegacyData() {
		return readJSON(STORE_KEY) == null && LEGACY_KEYS.some(key => readJSON(key) != null);
	}
}

export const roomStore = new RoomStore();
