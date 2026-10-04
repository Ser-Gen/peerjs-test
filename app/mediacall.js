import { CH } from './protocol.js';
import { Emitter } from './emitter.js';

const MAX_SDP = 32000;
const MAX_CANDIDATE = 1000;
const MAX_PENDING = 200; // candidates that arrive before the description they belong to
const MAX_META = 1000;
const ICE_RESTARTS = 2; // after ICE fails, the caller tries this many restarts before it gives up on the call
const CALLEE_GIVE_UP = 30000; // a callee whose ICE failed waits this long for the caller's restart
const CALL_ID = /^[0-9a-f]{16}$/;
const MUSIC_BITRATE = 256000;

/**
 * WebRTC tunes Opus for speech by default: mono, about 32 kbit/s, silence dropped. For screen audio (and a game) ask
 * for stereo at a music bitrate. Both sides apply it to their own SDP, since the sender follows the answer.
 */
export function musicSdp(sdp) {
	const pt = /a=rtpmap:(\d+) opus\/48000/i.exec(sdp)?.[1];
	if (!pt) return sdp;
	return sdp.replace(new RegExp(`a=fmtp:${pt} (.*)`), (_, params) => {
		const kept = params.split(';').map(p => p.trim()).filter(p => p && !/^(stereo|sprop-stereo|maxaveragebitrate|usedtx)=/.test(p));
		return `a=fmtp:${pt} ${[...kept, 'stereo=1', 'sprop-stereo=1', `maxaveragebitrate=${MUSIC_BITRATE}`, 'usedtx=0'].join(';')}`;
	});
}

/*
 * A media call between two members, negotiated over their link (ch 'rtc') instead of through the signaling
 * server. The link is already up and authenticated, so an offer can't get lost on a server connection that
 * went quiet without closing: a call works whenever the chat does. It has the shape of a peerjs
 * MediaConnection (connectionId, peer, metadata, peerConnection, open, answer(stream, options), close(),
 * 'stream' / 'close' / 'error'), so app/voice.js and the Stream tool don't need to know.
 *
 * Protocol (ch: 'rtc'); `call` is the call's ID, 16 hex characters, made by the caller:
 *   offer  {call, sdp, meta}   caller → callee; again with the same ID for an ICE restart
 *   answer {call, sdp}
 *   ice    {call, c: {candidate, sdpMid, sdpMLineIndex}}
 *   close  {call}             either side ended the call (peerjs never said so; this does)
 */
export class MediaCall extends Emitter {
	constructor({ room, peerId, id, metadata = {}, caller, stream = null, sdpTransform = null, offer = null }) {
		super();
		this.room = room;
		this.peer = peerId;
		this.connectionId = id;
		this.metadata = metadata;
		this.caller = caller;
		this.localStream = stream;
		this.remoteStream = null;
		this.sdpTransform = typeof sdpTransform === 'function' ? sdpTransform : null;
		this.peerConnection = null;
		this.offer = offer; // the callee's offer, until it answers
		this.pending = [];
		this.answered = false;
		this.closed = false;
		this.restarts = 0;
		this.giveUp = null;
		this._open = false;
	}

	get open() {
		return this._open;
	}

	/** The callee takes the call, sending `stream` back (none for receive only). */
	answer(stream = null, options = {}) {
		if (this.caller || this.answered || this.closed) return;
		this.answered = true;
		this.localStream = stream ?? null;
		if (typeof options?.sdpTransform === 'function') this.sdpTransform = options.sdpTransform;
		const offer = this.offer;
		this.offer = null;
		this._answer(offer);
	}

	close({ notify = true } = {}) {
		if (this.closed) return;
		this.closed = true;
		this._open = false;
		clearTimeout(this.giveUp);
		if (notify) this._send('close');
		const pc = this.peerConnection;
		if (pc) {
			pc.onicecandidate = pc.ontrack = pc.oniceconnectionstatechange = null;
			try {
				pc.close();
			} catch {
				// already closed
			}
		}
		this.pending = [];
		this.room._forgetCall(this);
		this.emit('close');
	}

	// --- negotiation ---

	async _start() {
		try {
			const pc = this._connection();
			for (const track of this.localStream?.getTracks() ?? []) pc.addTrack(track, this.localStream);
			await this._offer();
		} catch (err) {
			this._fail(err);
		}
	}

	async _offer(iceRestart = false) {
		const pc = this.peerConnection;
		const desc = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
		const sdp = this._transform(desc.sdp);
		await pc.setLocalDescription({ type: 'offer', sdp });
		if (!this.closed) this._send('offer', { sdp, meta: this.metadata });
	}

	async _answer(sdp) {
		try {
			const first = !this.peerConnection;
			const pc = this._connection();
			await pc.setRemoteDescription({ type: 'offer', sdp }); // their tracks arrive here, as 'stream'
			if (this.closed) return;
			// After the offer, so the tracks go out on the transceivers it made rather than on new ones.
			if (first) for (const track of this.localStream?.getTracks() ?? []) pc.addTrack(track, this.localStream);
			await this._flush();
			const desc = await pc.createAnswer();
			const local = this._transform(desc.sdp);
			await pc.setLocalDescription({ type: 'answer', sdp: local });
			if (this.closed) return;
			this._open = true;
			this._send('answer', { sdp: local });
		} catch (err) {
			this._fail(err);
		}
	}

	_connection() {
		if (this.peerConnection) return this.peerConnection;
		const pc = (this.peerConnection = new RTCPeerConnection(this.room.rtcConfig));
		pc.onicecandidate = event => {
			const c = event.candidate;
			if (c?.candidate) this._send('ice', { c: { candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null } });
		};
		pc.ontrack = event => {
			if (this.closed) return;
			const stream = event.streams?.[0] ?? this.remoteStream ?? new MediaStream();
			if (!event.streams?.[0] && !stream.getTracks().includes(event.track)) stream.addTrack(event.track);
			this.remoteStream = stream;
			this.emit('stream', stream); // once per track, with the same stream, as peerjs does
		};
		pc.oniceconnectionstatechange = () => this._onIceState();
		return pc;
	}

	/** An offer for a call we already have: the caller restarting ICE, or a second offer before we answered. */
	_onOffer(sdp) {
		if (this.caller || this.closed) return;
		if (!this.answered) this.offer = sdp;
		else this._answer(sdp);
	}

	async _onAnswer(sdp) {
		if (!this.caller || this.closed || this.peerConnection?.signalingState !== 'have-local-offer') return;
		try {
			await this.peerConnection.setRemoteDescription({ type: 'answer', sdp });
			if (this.closed) return;
			this._open = true;
			await this._flush();
		} catch (err) {
			this._fail(err);
		}
	}

	_onIce(candidate) {
		if (this.closed) return;
		const pc = this.peerConnection;
		if (!pc?.remoteDescription) {
			if (this.pending.length < MAX_PENDING) this.pending.push(candidate);
			return;
		}
		pc.addIceCandidate(candidate).catch(() => {}); // a candidate that doesn't fit is only one route fewer
	}

	async _flush() {
		const pc = this.peerConnection;
		for (const candidate of this.pending.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
	}

	/**
	 * ICE that fails (a network change, a route that stopped working) is restarted by the caller over the link;
	 * only after that does the call end, and the side that closes it tells the other.
	 */
	_onIceState() {
		const pc = this.peerConnection;
		if (!pc || this.closed) return;
		const state = pc.iceConnectionState;
		this.emit('iceStateChanged', state);
		if (state === 'connected' || state === 'completed') {
			this.restarts = 0;
			clearTimeout(this.giveUp);
			this.giveUp = null;
			return;
		}
		if (state !== 'failed') return;
		if (!this.caller) {
			clearTimeout(this.giveUp);
			this.giveUp = setTimeout(() => {
				if (this.peerConnection?.iceConnectionState === 'failed') this.close();
			}, CALLEE_GIVE_UP);
			return;
		}
		if (this.restarts >= ICE_RESTARTS) {
			console.warn(`[peerkit] media call to ${this.peer}: no network route after ${ICE_RESTARTS} ICE restarts`);
			this.close();
			return;
		}
		this.restarts++;
		console.warn(`[peerkit] media call to ${this.peer}: ICE failed, restarting (${this.restarts}/${ICE_RESTARTS})`);
		this._offer(true).catch(err => this._fail(err));
	}

	_transform(sdp) {
		if (!this.sdpTransform) return sdp;
		try {
			return this.sdpTransform(sdp) || sdp;
		} catch {
			return sdp;
		}
	}

	_send(type, payload = {}) {
		return this.room.send(CH.RTC, { type, call: this.connectionId, ...payload }, this.peer) > 0;
	}

	_fail(err) {
		if (this.closed) return;
		console.warn('[peerkit] media call failed', err);
		this.emit('error', err);
		this.close();
	}
}

/** A signaling message from a member, checked; null when it isn't one. Everything a member sends is untrusted. */
export function readSignal(msg) {
	if (!msg || typeof msg !== 'object' || typeof msg.call !== 'string' || !CALL_ID.test(msg.call)) return null;
	switch (msg.type) {
		case 'offer':
		case 'answer': {
			if (typeof msg.sdp !== 'string' || !msg.sdp.length || msg.sdp.length > MAX_SDP) return null;
			return { type: msg.type, call: msg.call, sdp: msg.sdp, meta: msg.type === 'offer' ? readMeta(msg.meta) : null };
		}
		case 'ice': {
			const c = msg.c;
			if (!c || typeof c.candidate !== 'string' || c.candidate.length > MAX_CANDIDATE) return null;
			const sdpMid = typeof c.sdpMid === 'string' && c.sdpMid.length <= 64 ? c.sdpMid : null;
			const sdpMLineIndex = Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex < 64 ? c.sdpMLineIndex : null;
			if (sdpMid === null && sdpMLineIndex === null) return null;
			return { type: 'ice', call: msg.call, candidate: { candidate: c.candidate, sdpMid, sdpMLineIndex } };
		}
		case 'close':
			return { type: 'close', call: msg.call };
		default:
			return null;
	}
}

/** Metadata is a small plain object ({kind}, {id, kind}); anything else becomes empty, and the call is refused by kind. */
function readMeta(meta) {
	if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
	try {
		const text = JSON.stringify(meta);
		return text.length <= MAX_META ? JSON.parse(text) : {};
	} catch {
		return {};
	}
}
