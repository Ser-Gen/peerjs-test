import { Emitter } from './emitter.js';
import { HOST_RE, fromBase64url, toBase64url } from './settings.js';
import { readJSON, writeJSON } from './util.js';

/*
 * TURN relays the connection when two devices can't reach each other directly.
 *
 * This device's own server is a device setting (any signaling server, host or guest). With coturn's
 * `use-auth-secret`, credentials follow the TURN REST format:
 *   username   = "<unix expiry>:pk"
 *   credential = base64(HMAC-SHA1(secret, username))
 * The secret never leaves the device it was entered on: links (`&r=`) and room messages carry temporary
 * credentials only. Any member with a secret hands them out; the others keep the newest and pass them on.
 */

const STORAGE_KEY = 'peerkit.turn';
const VERSION = 1;
export const TURN_PORT = 3478;
export const TLS_PORT = 5349;
const HOUR = 3600 * 1000;
const OWN_TTL = 24 * HOUR; // what this device mints for its own connections
const ROOM_TTL = 7 * 24 * HOUR; // what goes into links and to the other members
const TEST_TIMEOUT = 8000;
const USER_LABEL = 'pk';
const VISIBLE_RE = /^[\x21-\x7e]{1,256}$/; // visible ASCII, no spaces

// peerjs 1.5.5 defaults, kept when there is no TURN server to use.
const PEERJS_ICE = [
	{ urls: 'stun:stun.l.google.com:19302' },
	{ urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
];

/** A user-facing validation problem; `message` is safe to show as is. */
export class TurnError extends Error {}

/**
 * Validate untrusted TURN settings (form, storage, import, link, peer).
 * Returns `{ host, port, tlsPort, secret }` or `{ host, port, tlsPort, username, credential }`; tlsPort null = no TLS.
 */
export function normalizeTurn(raw) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TurnError('TURN settings must be an object.');
	const host = text(raw.host).toLowerCase();
	if (!host) throw new TurnError('Enter the TURN host, e.g. turn.example.com.');
	if (!HOST_RE.test(host)) throw new TurnError(`“${host.slice(0, 60)}” is not a valid host name.`);
	const port = raw.port == null || raw.port === '' ? TURN_PORT : checkPort(raw.port, 'Port');
	// Missing means the default; empty, null or 0 turns TLS off.
	const tlsPort = raw.tlsPort === undefined ? TLS_PORT : raw.tlsPort === null || raw.tlsPort === '' || raw.tlsPort === 0 ? null : checkPort(raw.tlsPort, 'TLS port');
	const turn = { host, port, tlsPort };

	const secret = text(raw.secret);
	if (secret) {
		if (!VISIBLE_RE.test(secret)) throw new TurnError('The secret may contain only visible ASCII characters without spaces (up to 256).');
		return { ...turn, secret };
	}
	const username = text(raw.username);
	const credential = text(raw.credential);
	if (!username || !credential) throw new TurnError('Enter the shared secret, or a username and password.');
	if (!VISIBLE_RE.test(username) || !VISIBLE_RE.test(credential)) {
		throw new TurnError('The username and password may contain only visible ASCII characters without spaces (up to 256).');
	}
	return { ...turn, username, credential };
}

function checkPort(value, label) {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TurnError(`${label} must be a whole number from 1 to 65535.`);
	return port;
}

function text(value) {
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'number') return String(value);
	return '';
}

/** Credentials another member handed out (link, room message, stored room): never a secret, not expired. Null otherwise. */
export function parseGuestTurn(raw) {
	if (raw == null) return null;
	try {
		const turn = normalizeTurn(raw);
		return turn.secret || isExpired(turn) ? null : turn;
	} catch {
		return null;
	}
}

/** Expiry in ms of TURN REST credentials ("1726000000:pk"); null for fixed credentials. */
export function credentialExpiry(turn) {
	const match = /^(\d{9,11}):/.exec(turn?.username ?? '');
	return match ? Number(match[1]) * 1000 : null;
}

const isExpired = (turn, margin = 0) => {
	const expiry = credentialExpiry(turn);
	return expiry != null && expiry - margin <= Date.now();
};

/** WebCrypto, and so a shared secret, only works in a secure context (HTTPS or localhost). */
export const canMint = () => Boolean(globalThis.crypto?.subtle);

async function mint(server, ttl) {
	const username = `${Math.floor((Date.now() + ttl) / 1000)}:${USER_LABEL}`;
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey('raw', encoder.encode(server.secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
	const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(username)));
	return { host: server.host, port: server.port, tlsPort: server.tlsPort, username, credential: btoa(String.fromCharCode(...signature)) };
}

/** Usable credentials: minted from a secret, or the fixed ones as they are. */
const credentialsFor = (server, ttl) => (server.secret ? mint(server, ttl) : Promise.resolve(server));

function turnUrls({ host, port, tlsPort }) {
	return [
		['UDP', `turn:${host}:${port}?transport=udp`],
		['TCP', `turn:${host}:${port}?transport=tcp`],
		...(tlsPort ? [['TLS', `turns:${host}:${tlsPort}?transport=tcp`]] : []),
	];
}

function turnIceServers(turn) {
	const { username, credential } = turn;
	return [{ urls: `stun:${turn.host}:${turn.port}` }, { urls: turnUrls(turn).map(([, url]) => url), username, credential }];
}

const sameTurn = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- links: &r=<base64url(JSON)> with short keys and defaults left out ---

export function encodeTurn(turn) {
	const compact = { h: turn.host, u: turn.username, c: turn.credential };
	if (turn.port !== TURN_PORT) compact.p = turn.port;
	if (turn.tlsPort !== TLS_PORT) compact.t = turn.tlsPort ?? 0;
	return toBase64url(JSON.stringify(compact));
}

/** Credentials from a link; null when damaged or expired (the link still works without them). */
export function decodeTurn(encoded) {
	try {
		const compact = JSON.parse(fromBase64url(encoded));
		return parseGuestTurn({ host: compact?.h, port: compact?.p, tlsPort: compact?.t, username: compact?.u, credential: compact?.c });
	} catch {
		console.warn('[peerkit] ignoring damaged TURN credentials in the link');
		return null;
	}
}

// --- storage ---

/** This device's TURN server and the relay-only switch. Emits 'change'. */
class TurnSettings extends Emitter {
	constructor() {
		super();
		this._data = this._load();
		window.addEventListener('storage', e => {
			if (e.key !== STORAGE_KEY) return;
			this._data = this._load();
			this.emit('change');
		});
	}

	get server() {
		return this._data.server;
	}

	get relayOnly() {
		return this._data.relayOnly;
	}

	/** Throws TurnError for invalid fields. */
	save(fields) {
		const server = normalizeTurn(fields);
		this._commit({ ...this._data, server });
		return server;
	}

	remove() {
		this._commit({ ...this._data, server: null });
	}

	setRelayOnly(on) {
		this._commit({ ...this._data, relayOnly: Boolean(on) });
	}

	_load() {
		const raw = readJSON(STORAGE_KEY);
		const data = { version: VERSION, server: null, relayOnly: false };
		if (raw?.version !== VERSION) return data;
		try {
			if (raw.server) data.server = normalizeTurn(raw.server);
		} catch (err) {
			console.warn('[peerkit] dropping invalid TURN settings', err);
		}
		data.relayOnly = raw.relayOnly === true;
		return data;
	}

	_commit(next) {
		if (!writeJSON(STORAGE_KEY, next)) throw new TurnError('Could not save: browser storage is unavailable.');
		this._data = next;
		this.emit('change');
	}
}

export const turnSettings = new TurnSettings();

// --- the ICE config of a session ---

/**
 * Owns the RTCConfiguration handed to peerjs (`config`). peerjs keeps that object and reads it for every
 * new RTCPeerConnection, so changing its fields in place reaches reconnects and media calls without a new Peer.
 * Emits 'change' when the credentials in use or those for guests change.
 */
export class IceConfig extends Emitter {
	constructor({ base = null } = {}) {
		super();
		this.base = base; // the server profile's own iceServers, if any
		this.config = { iceServers: base ?? PEERJS_ICE, sdpSemantics: 'unified-plan' };
		this.own = null; // credentials from this device's server
		this.fromRoom = null; // temporary credentials from the link, the stored room or another member
		this.minted = null; // from this device's server, for links and the other members
		this._run = 0;
		turnSettings.on('change', () => this.prepare());
	}

	/** The credentials connections use now. This device's own server wins over the room's. */
	get active() {
		return this.own ?? this.fromRoom;
	}

	get source() {
		return this.own ? 'own' : this.fromRoom ? 'room' : null;
	}

	/** Temporary credentials to put in links and send to members: our own, or the newest we were given. */
	get forRoom() {
		return this.minted ?? this.fromRoom;
	}

	/** Create credentials from the settings. Await it before the Peer is created. Never rejects. */
	async prepare() {
		const run = ++this._run;
		const server = turnSettings.server;
		let own = null;
		let minted = null;
		if (server && (!server.secret || canMint())) {
			try {
				own = await credentialsFor(server, OWN_TTL);
				minted = await credentialsFor(server, ROOM_TTL); // a username and password are shared as they are
			} catch (err) {
				console.warn('[peerkit] could not create TURN credentials', err);
				own = minted = null;
			}
		}
		if (run !== this._run) return;
		this.own = own;
		this.minted = minted;
		this._apply();
	}

	/**
	 * Take temporary credentials from a link or another member. Expired ones are ignored, and so are ones
	 * that expire sooner than those we have. Returns whether they were taken.
	 */
	adopt(turn) {
		if (!turn || isExpired(turn) || sameTurn(turn, this.fromRoom)) return false;
		const current = this.fromRoom && !isExpired(this.fromRoom) ? credentialExpiry(this.fromRoom) : null;
		const next = credentialExpiry(turn);
		if (current != null && (next == null || next <= current)) return false;
		this.fromRoom = turn;
		this._apply();
		return true;
	}

	/** Replace credentials that expire soon. Cheap; call it on wake-up and now and then. */
	refresh() {
		const server = turnSettings.server;
		// Links keep at least 6 of their 7 days.
		if (server?.secret && (isExpired(this.own, OWN_TTL / 2) || isExpired(this.minted, ROOM_TTL - 24 * HOUR))) this.prepare();
		if (this.fromRoom && isExpired(this.fromRoom)) {
			this.fromRoom = null;
			this._apply();
		}
	}

	_apply() {
		const turn = this.active;
		this.config.iceServers = turn ? [...turnIceServers(turn), ...(this.base ?? [])] : (this.base ?? PEERJS_ICE);
		// Relay only without a relay would fail every connection.
		if (turn && turnSettings.relayOnly) this.config.iceTransportPolicy = 'relay';
		else delete this.config.iceTransportPolicy;
		this.emit('change');
	}
}

// --- relay test ---

/**
 * Ask the server for a relay candidate over each transport (UDP, TCP, TLS).
 * Resolves `{ ok, ms, results: [{ transport, ok, error }], error }`; never rejects.
 * Result errors: 'auth' (401), 'unreachable' (701), 'timeout', or another STUN code.
 */
export async function testTurn(server, timeout = TEST_TIMEOUT) {
	const started = performance.now();
	if (server.secret && !canMint()) return { ok: false, ms: 0, results: [], error: 'insecure' };
	let turn;
	try {
		turn = await credentialsFor(server, 10 * 60 * 1000);
	} catch {
		return { ok: false, ms: 0, results: [], error: 'mint' };
	}
	const results = await Promise.all(turnUrls(turn).map(([transport, url]) => probe(transport, url, turn, timeout)));
	return { ok: results.some(r => r.ok), ms: Math.round(performance.now() - started), results, error: null };
}

function probe(transport, url, { username, credential }, timeout) {
	return new Promise(resolve => {
		let pc = null;
		let error = null;
		let done = false;
		const finish = ok => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try {
				pc?.close();
			} catch {
				// already closed
			}
			resolve({ transport, ok, error: ok ? null : (error ?? 'timeout') });
		};
		const timer = setTimeout(() => finish(false), timeout);
		try {
			pc = new RTCPeerConnection({ iceServers: [{ urls: url, username, credential }], iceTransportPolicy: 'relay' });
		} catch {
			error = 'invalid';
			finish(false);
			return;
		}
		pc.addEventListener('icecandidate', e => {
			if (!e.candidate) finish(false); // gathering finished without a relay
			else if (e.candidate.type === 'relay' || / typ relay /.test(e.candidate.candidate)) finish(true);
		});
		pc.addEventListener('icecandidateerror', e => {
			error = e.errorCode === 401 ? 'auth' : e.errorCode === 701 ? 'unreachable' : `code ${e.errorCode}`;
		});
		pc.createDataChannel('probe');
		pc.createOffer()
			.then(offer => pc.setLocalDescription(offer))
			.catch(() => {
				error = 'webrtc';
				finish(false);
			});
	});
}

// --- route ---

/** How a connection runs right now: `{ relayed, protocol }` (protocol of our own relay, if any), or null if unknown. */
export async function detectRoute(pc) {
	if (!pc?.getStats) return null;
	let stats;
	try {
		stats = await pc.getStats();
	} catch {
		return null;
	}
	let pair = null;
	stats.forEach(report => {
		if (report.type === 'transport' && report.selectedCandidatePairId) pair ??= stats.get(report.selectedCandidatePairId);
	});
	// Firefox marks the pair instead.
	stats.forEach(report => {
		if (report.type === 'candidate-pair' && (report.selected || (report.nominated && report.state === 'succeeded'))) pair ??= report;
	});
	const local = pair && stats.get(pair.localCandidateId);
	const remote = pair && stats.get(pair.remoteCandidateId);
	if (!local || !remote) return null;
	const ownRelay = local.candidateType === 'relay';
	return { relayed: ownRelay || remote.candidateType === 'relay', protocol: ownRelay ? (local.relayProtocol ?? null) : null };
}
