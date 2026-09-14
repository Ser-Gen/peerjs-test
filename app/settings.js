/* global Peer */
import { Emitter } from './emitter.js';
import { randomId } from './util.js';

const STORAGE_KEY = 'peerkit.settings';
const SETTINGS_VERSION = 1;
const MAX_PROFILES = 50;
export const TEST_TIMEOUT = 10000;

const DEFAULT_PORT = 443;
const DEFAULT_PATH = '/';
const DEFAULT_KEY = 'peerjs';

export const PUBLIC_PROFILE = Object.freeze({
	id: 'public',
	name: 'Public (default)',
	host: '0.peerjs.com',
	port: DEFAULT_PORT,
	path: DEFAULT_PATH,
	key: DEFAULT_KEY,
	secure: true,
	builtin: true,
});

export const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const PATH_RE = /^\/(?:[A-Za-z0-9._~-]+\/)*$/;
const KEY_RE = /^[A-Za-z0-9._~-]{1,64}$/;
const ICE_URL_RE = /^(?:stun|stuns|turn|turns):\S{1,250}$/;
const ID_RE = /^[0-9a-f]{8}$/;

/** A user-facing validation problem; `message` is safe to show as is. */
export class ProfileError extends Error {}

/**
 * Validate untrusted server settings (form, link, import, storage) and fill in defaults.
 * Returns `{ name, host, port, path, key, secure, iceServers? }` or throws ProfileError.
 */
export function normalizeProfile(raw) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ProfileError('Server settings must be an object.');
	const host = text(raw.host).toLowerCase();
	if (!host) throw new ProfileError('Enter the server host, e.g. peer.example.com.');
	if (!HOST_RE.test(host)) throw new ProfileError(`“${host.slice(0, 60)}” is not a valid host name.`);
	if (raw.secure != null && typeof raw.secure !== 'boolean') throw new ProfileError('“secure” must be true or false.');
	const secure = raw.secure ?? true;
	const port = raw.port == null || raw.port === '' ? (secure ? 443 : 80) : Number(raw.port);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ProfileError('Port must be a whole number from 1 to 65535.');
	let path = text(raw.path) || DEFAULT_PATH;
	if (!path.startsWith('/')) path = `/${path}`;
	if (!path.endsWith('/')) path += '/'; // peerjs adds it too; keeps comparisons stable
	if (path.length > 200 || !PATH_RE.test(path)) throw new ProfileError('Path may contain only letters, digits, “/” and - . _ ~');
	const key = text(raw.key) || DEFAULT_KEY;
	if (!KEY_RE.test(key)) throw new ProfileError('Key may contain only letters, digits and - . _ ~ (up to 64 characters).');
	const name = (text(raw.name).replace(/[\u0000-\u001f\u007f]/g, '') || host).slice(0, 40);

	const profile = { name, host, port, path, key, secure };
	const iceServers = normalizeIceServers(raw.iceServers);
	if (iceServers) profile.iceServers = iceServers;
	return profile;
}

function normalizeIceServers(value) {
	if (value == null) return undefined;
	const invalid = () => new ProfileError('The ICE server list is invalid.');
	if (!Array.isArray(value) || value.length > 10) throw invalid();
	const list = value.map(server => {
		if (!server || typeof server !== 'object') throw invalid();
		const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
		if (!urls.length || urls.length > 10 || !urls.every(url => typeof url === 'string' && ICE_URL_RE.test(url))) throw invalid();
		const out = { urls: Array.isArray(server.urls) ? urls : urls[0] };
		for (const field of ['username', 'credential']) {
			if (server[field] == null) continue;
			if (typeof server[field] !== 'string' || server[field].length > 200) throw invalid();
			out[field] = server[field];
		}
		return out;
	});
	return list.length ? list : undefined;
}

function text(value) {
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'number') return String(value);
	return '';
}

/** Two profiles point at the same server if these match (the name and `secure` don't count). */
export const serverKey = p => `${p.host}:${p.port}${p.path}?key=${p.key}`;

export const isPublic = p => serverKey(p) === serverKey(PUBLIC_PROFILE);

/** Signaling options for `new Peer()`. The ICE config (STUN/TURN) comes from `IceConfig` in turn.js. */
export function peerOptions(p) {
	return { host: p.host, port: p.port, path: p.path, key: p.key, secure: p.secure };
}

const connectionKey = p => JSON.stringify([peerOptions(p), p.iceServers ?? null]);

/** True when both profiles produce the same connection, whatever their names. */
export const sameConnection = (a, b) => connectionKey(a) === connectionKey(b);

export function serverAddress(p) {
	const defaultPort = p.secure ? 443 : 80;
	const port = p.port === defaultPort ? '' : `:${p.port}`;
	const path = p.path === '/' ? '' : p.path.slice(0, -1);
	const key = p.key === DEFAULT_KEY ? '' : ` · key ${p.key}`;
	return `${p.secure ? 'https' : 'http'}://${p.host}${port}${path}${key}`;
}

/** An HTTPS page can't open ws:// to anything but the local machine (mixed content). */
export function blockedAsMixedContent(p) {
	return !p.secure && location.protocol === 'https:' && !/^(?:localhost|127(?:\.\d{1,3}){3})$/.test(p.host);
}

// --- link encoding: #join=<id>&s=<base64url(JSON)> with short keys and defaults left out ---

export function encodeProfile(p) {
	const compact = { h: p.host };
	if (p.name !== p.host) compact.n = p.name;
	if (p.port !== DEFAULT_PORT) compact.p = p.port;
	if (p.path !== DEFAULT_PATH) compact.a = p.path;
	if (p.key !== DEFAULT_KEY) compact.k = p.key;
	if (!p.secure) compact.s = 0;
	if (p.iceServers) compact.i = p.iceServers;
	return toBase64url(JSON.stringify(compact));
}

export function decodeProfile(encoded) {
	let compact;
	try {
		compact = JSON.parse(fromBase64url(encoded));
	} catch {
		throw new ProfileError('The server settings in this link are damaged.');
	}
	if (!compact || typeof compact !== 'object' || Array.isArray(compact)) throw new ProfileError('The server settings in this link are damaged.');
	const secure = compact.s == null ? undefined : compact.s === 0 ? false : compact.s === 1 ? true : compact.s;
	return normalizeProfile({ name: compact.n, host: compact.h, port: compact.p, path: compact.a, key: compact.k, secure, iceServers: compact.i });
}

export function toBase64url(str) {
	let binary = '';
	for (const byte of new TextEncoder().encode(str)) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(encoded) {
	if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]{1,4000}$/.test(encoded)) throw new Error('not base64url');
	const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
	return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, ch => ch.charCodeAt(0)));
}

// --- connection test ---

/** Register a throwaway Peer on the server. Resolves `{ ok, ms, error }`; never rejects. */
export function testServer(profile, timeout = TEST_TIMEOUT) {
	return new Promise(resolve => {
		const started = performance.now();
		let peer = null;
		let done = false;
		const finish = error => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try {
				peer?.destroy();
			} catch {
				// already gone
			}
			resolve({ ok: !error, error, ms: Math.round(performance.now() - started) });
		};
		const timer = setTimeout(() => finish('timeout'), timeout);
		if (typeof Peer !== 'function') return finish('browser-incompatible');
		try {
			// debug must match the session's: peerjs keeps one global log level.
			peer = new Peer({ debug: 1, ...peerOptions(profile) });
		} catch (err) {
			console.warn('[peerkit] test peer failed', err);
			return finish('server-error');
		}
		peer.on('open', () => finish(null));
		peer.on('error', err => finish(err?.type ?? 'unknown'));
	});
}

// --- storage ---

/** Saved server profiles plus the built-in public one. Emits 'change'. */
class ProfileStore extends Emitter {
	constructor() {
		super();
		this._data = this._load();
		window.addEventListener('storage', e => {
			if (e.key !== STORAGE_KEY) return;
			this._data = this._load();
			this.emit('change');
		});
	}

	list() {
		return [PUBLIC_PROFILE, ...this._data.profiles];
	}

	get(id) {
		return this.list().find(p => p.id === id) ?? null;
	}

	get active() {
		return this.get(this._data.activeId) ?? PUBLIC_PROFILE;
	}

	findSame(profile) {
		const key = serverKey(profile);
		return this.list().find(p => serverKey(p) === key) ?? null;
	}

	setActive(id) {
		if (!this.get(id)) throw new ProfileError('This server no longer exists.');
		this._commit({ ...this._data, activeId: id });
	}

	/** Add (no id) or replace a profile. Throws ProfileError for invalid fields or a server that is already saved. */
	save(fields, { id = null, activate = false } = {}) {
		const profile = normalizeProfile(fields);
		const saved = this._data.profiles;
		if (id && !saved.some(p => p.id === id)) throw new ProfileError('This server can no longer be edited.');
		const same = this.findSame(profile);
		if (same && same.id !== id) {
			throw new ProfileError(same.builtin ? 'This is the built-in public server.' : `“${same.name}” already uses this server.`);
		}
		if (!id && saved.length >= MAX_PROFILES) throw new ProfileError(`You can save up to ${MAX_PROFILES} servers.`);

		const entry = { id: id ?? newId(), ...profile };
		const profiles = id ? saved.map(p => (p.id === id ? entry : p)) : [...saved, entry];
		this._commit({ ...this._data, profiles, activeId: activate ? entry.id : this._data.activeId });
		return entry;
	}

	remove(id) {
		const profiles = this._data.profiles.filter(p => p.id !== id);
		const activeId = this._data.activeId === id ? PUBLIC_PROFILE.id : this._data.activeId;
		this._commit({ ...this._data, profiles, activeId });
	}

	/** `extra` adds top-level fields, e.g. `{ turn }`. */
	exportJSON(extra = {}) {
		const profiles = this._data.profiles.map(({ id, ...profile }) => profile);
		return JSON.stringify({ app: 'peerkit', version: SETTINGS_VERSION, profiles, ...extra }, null, 2);
	}

	/**
	 * Import exported JSON or a PeerKit link. Servers that are already saved are skipped.
	 * `turn` is the raw, unvalidated TURN block of exported JSON, for the caller to apply.
	 */
	importText(input) {
		const { entries, turn } = parseImport(input);
		const profiles = [...this._data.profiles];
		const known = new Set([PUBLIC_PROFILE, ...profiles].map(serverKey));
		let added = 0;
		let existing = 0;
		let invalid = 0;
		for (const entry of entries) {
			let profile;
			try {
				profile = normalizeProfile(entry);
			} catch {
				invalid++;
				continue;
			}
			const key = serverKey(profile);
			if (known.has(key)) {
				existing++;
				continue;
			}
			if (profiles.length >= MAX_PROFILES) break;
			known.add(key);
			profiles.push({ id: newId(), ...profile });
			added++;
		}
		if (!added && !existing && !turn) throw new ProfileError('No valid servers found in this text.');
		if (added) this._commit({ ...this._data, profiles });
		return { added, existing, invalid, turn };
	}

	_load() {
		let raw = null;
		try {
			raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
		} catch (err) {
			console.warn('[peerkit] could not read settings', err);
		}
		const empty = { version: SETTINGS_VERSION, activeId: PUBLIC_PROFILE.id, profiles: [] };
		if (raw == null) return empty;
		// Future format changes: migrate older versions here.
		if (raw.version !== SETTINGS_VERSION || !Array.isArray(raw.profiles)) {
			console.warn('[peerkit] ignoring settings in an unknown format', raw);
			return empty;
		}
		const profiles = [];
		for (const entry of raw.profiles.slice(0, MAX_PROFILES)) {
			try {
				profiles.push({ id: ID_RE.test(entry?.id) ? entry.id : newId(), ...normalizeProfile(entry) });
			} catch (err) {
				console.warn('[peerkit] dropping an invalid saved server', entry, err);
			}
		}
		const activeId = profiles.some(p => p.id === raw.activeId) ? raw.activeId : PUBLIC_PROFILE.id;
		return { version: SETTINGS_VERSION, activeId, profiles };
	}

	_commit(next) {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
		} catch (err) {
			console.warn('[peerkit] could not save settings', err);
			throw new ProfileError('Could not save: browser storage is unavailable.');
		}
		this._data = next;
		this.emit('change');
	}
}

function parseImport(input) {
	const trimmed = String(input ?? '').trim();
	if (!trimmed) throw new ProfileError('Paste exported servers or a PeerKit link first.');
	if (/^[[{]/.test(trimmed)) {
		let data;
		try {
			data = JSON.parse(trimmed);
		} catch {
			throw new ProfileError('This text is not valid JSON.');
		}
		const turn = data && typeof data.turn === 'object' && !Array.isArray(data) ? data.turn : null;
		const list = Array.isArray(data) ? data : Array.isArray(data?.profiles) ? data.profiles : turn ? [] : [data];
		return { entries: list.slice(0, MAX_PROFILES), turn };
	}
	const hash = trimmed.includes('#') ? new URLSearchParams(trimmed.slice(trimmed.indexOf('#') + 1)) : null;
	if (hash?.has('s')) return { entries: [decodeProfile(hash.get('s'))], turn: null };
	if (hash?.has('join')) throw new ProfileError('This link uses the public server, which is always available.');
	throw new ProfileError('Paste exported servers (JSON) or a PeerKit link.');
}

const newId = () => randomId(4);

export const profiles = new ProfileStore();
