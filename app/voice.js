import { CH } from './protocol.js';
import { Emitter } from './emitter.js';
import { readJSON, wakeLock, writeJSON } from './util.js';

const PREFS_KEY = 'peerkit.voice';
const CAPTURE = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const LEVEL_EVERY = 100; // ms between level samples
const SPEAKING_LEVEL = 0.05; // RMS above which someone counts as speaking
const SPEAKING_HOLD = 400; // ms the mark stays after the level drops, so it doesn't flicker
const REDIAL_DELAY = 1000;
const REDIAL_TRIES = 5;

/*
 * Voice in the room: an open microphone with a mute button, for everyone who joins it.
 *
 * Protocol (ch: 'voice'). Media goes over a peerjs call with metadata {kind: 'voice'}.
 *   state {on, muted, mic}   the sender's voice state; sent on every link up and whenever it changes
 *
 * One call per pair, not per direction: of two members in voice the one with a microphone dials, and when
 * both have one the lower peer ID dials (the rule the links use). The other answers with its own
 * microphone, so a single connection carries both voices. A device with no microphone, or one that refused
 * it, joins as a listener: it is always muted, never dials, and is called by the others.
 *
 * Mute is `track.enabled = false` plus a `state` message, because peerjs cannot renegotiate a call;
 * joining and leaving voice do close and re-make the calls with the members it concerns.
 */
export class Voice extends Emitter {
	constructor(room) {
		super();
		this.room = room;
		this.active = false; // this device is in the voice conversation
		this.muted = false;
		this.busy = false; // waiting for the microphone prompt
		this.blocked = false; // the browser refused to play the others; a tap fixes it
		this.stream = null; // this device's microphone, null for a listener
		this.peers = new Map(); // peerId → what we know and hold for that member
		this.prefs = loadPrefs();
		this.self = { since: 0, speaking: false };
		this.audioCtx = null;
		this.localLevel = null;
		this.levelTimer = null;
		this.root = null; // the <audio> elements live here, outside the tool panels

		this.unsubscribe = [
			room.on(`msg:${CH.VOICE}`, (msg, member) => this.onMessage(msg, member)),
			room.on('call', (call, member) => this.onCall(call, member)),
			room.on('link-up', member => this.onLinkUp(member)),
			room.on('link-down', member => this.onLinkDown(member)),
		];
	}

	destroy() {
		this.unsubscribe.forEach(fn => fn());
		this.leave();
		this.root?.remove();
		this.root = null;
	}

	// --- what the UI asks ---

	/** Members who are in voice, whether or not they can be heard yet. */
	get others() {
		return [...this.peers.values()].filter(peer => peer.active);
	}

	get count() {
		return this.others.length + (this.active ? 1 : 0);
	}

	/** 'speaking' | 'muted' | 'on' for a member in voice, null for one who isn't. */
	mark(peerId) {
		const peer = this.peers.get(peerId);
		if (!peer?.active) return null;
		return peer.muted ? 'muted' : peer.speaking ? 'speaking' : 'on';
	}

	get selfMark() {
		if (!this.active) return null;
		return this.muted ? 'muted' : this.self.speaking ? 'speaking' : 'on';
	}

	/** A listener has no microphone of its own: it hears the room and can't be heard. */
	get listening() {
		return this.active && !this.stream;
	}

	volumeOf(deviceId) {
		return this.prefs.peers[deviceId]?.volume ?? 1;
	}

	mutedFor(deviceId) {
		return this.prefs.peers[deviceId]?.muted === true;
	}

	// --- joining and leaving ---

	/** Returns a note for the user when the microphone could not be opened; the room is joined either way. */
	async join() {
		if (this.active || this.busy) return null;
		this.busy = true;
		this.changed();
		let stream = null;
		let note = null;
		try {
			stream = await this.capture();
		} catch (err) {
			note = micError(err);
		}
		this.busy = false;
		this.stream = stream;
		this.active = true;
		this.muted = !stream; // a listener is muted, and stays that way
		this.localLevel = this.analyse(stream);
		this.startLevels();
		wakeLock.acquire();
		this.announce();
		for (const peer of this.peers.values()) this.sync(peer);
		this.changed();
		return note;
	}

	leave() {
		if (!this.active) return;
		this.active = false;
		this.muted = false;
		this.blocked = false;
		this.announce(); // before the calls close, so nobody dials back
		for (const peer of this.peers.values()) this.endCall(peer);
		stopStream(this.stream);
		this.stream = null;
		this.stopLevels();
		this.self = { since: 0, speaking: false };
		this.localLevel = null;
		this.audioCtx?.close?.().catch(() => {});
		this.audioCtx = null;
		wakeLock.release();
		this.changed();
	}

	setMuted(muted) {
		if (!this.active || !this.stream || muted === this.muted) return;
		this.muted = muted;
		for (const track of this.stream.getAudioTracks()) track.enabled = !muted;
		if (muted) this.self = { since: 0, speaking: false };
		this.announce();
		this.changed();
	}

	toggleMute() {
		this.setMuted(!this.muted);
	}

	async capture() {
		if (!navigator.mediaDevices?.getUserMedia) throw new DOMException('No microphone here', 'NotFoundError');
		if (!this.prefs.mic) return navigator.mediaDevices.getUserMedia({ audio: { ...CAPTURE } });
		try {
			return await navigator.mediaDevices.getUserMedia({ audio: { ...CAPTURE, deviceId: { exact: this.prefs.mic } } });
		} catch {
			this.savePrefs({ mic: null }); // the remembered microphone is gone: take the default one
			return navigator.mediaDevices.getUserMedia({ audio: { ...CAPTURE } });
		}
	}

	// --- the room ---

	announce(to = null) {
		this.room.send(CH.VOICE, { type: 'state', on: this.active, muted: this.muted, mic: Boolean(this.stream) }, to);
	}

	onLinkUp(member) {
		this.peerFor(member);
		if (this.active) this.announce(member.peerId);
		this.changed();
	}

	onLinkDown(member) {
		const peer = this.peers.get(member.peerId);
		if (!peer) return;
		this.endCall(peer);
		this.peers.delete(member.peerId); // a reload comes back as a new peer ID
		this.changed();
	}

	onMessage(msg, member) {
		if (msg?.type !== 'state') return;
		const peer = this.peerFor(member);
		const was = peer.active;
		peer.active = msg.on === true;
		peer.muted = msg.muted === true;
		peer.mic = msg.mic !== false;
		if (!peer.active) this.endCall(peer);
		else if (!was) peer.tries = 0;
		this.sync(peer);
		this.changed();
	}

	onCall(call, member) {
		if (call.metadata?.kind !== 'voice') return; // camera and screen belong to the Stream tool
		if (!this.active) {
			call.close(); // not in voice: nothing to answer with, and nothing should start playing
			return;
		}
		const peer = this.peerFor(member);
		peer.active = true; // they would not be calling otherwise
		this.endCall(peer); // one call per pair: a new one replaces what was there
		this.attach(peer, call);
		call.answer(this.stream ?? undefined);
		this.changed();
	}

	peerFor(member) {
		let peer = this.peers.get(member.peerId);
		if (!peer) {
			peer = {
				peerId: member.peerId,
				deviceId: member.deviceId,
				name: member.name,
				active: false,
				muted: false,
				mic: true,
				call: null,
				audio: null,
				level: null,
				since: 0,
				speaking: false,
				tries: 0,
				timer: null,
			};
			this.peers.set(member.peerId, peer);
		}
		peer.name = member.name;
		return peer;
	}

	/** Call this member if we are the side that dials and there is no call yet. */
	sync(peer) {
		if (!this.active || !peer.active || peer.call || !this.stream) return;
		if (!this.room.member(peer.peerId)) return;
		if (peer.mic && this.room.self.peerId > peer.peerId) return; // they dial
		const call = this.room.call(peer.peerId, this.stream, { kind: 'voice' });
		if (call) this.attach(peer, call);
		else this.retry(peer);
	}

	attach(peer, call) {
		peer.call = call;
		call.on('stream', stream => {
			if (peer.call !== call) return;
			peer.tries = 0;
			this.play(peer, stream);
			this.changed();
		});
		call.on('close', () => {
			if (peer.call !== call) return;
			peer.call = null;
			this.stopAudio(peer);
			this.changed();
			this.retry(peer);
		});
		call.on('error', err => console.warn('[peerkit] voice call error', err));
	}

	/** A call that fell over while both sides are still in voice: try again, a few times. */
	retry(peer) {
		clearTimeout(peer.timer);
		peer.timer = null;
		if (!this.active || !peer.active || !this.stream || peer.tries >= REDIAL_TRIES) return;
		peer.tries++;
		peer.timer = setTimeout(() => {
			peer.timer = null;
			if (this.room.member(peer.peerId)) this.sync(peer);
		}, REDIAL_DELAY);
	}

	endCall(peer) {
		clearTimeout(peer.timer);
		peer.timer = null;
		const call = peer.call;
		peer.call = null;
		try {
			call?.close();
		} catch {
			// already closed
		}
		this.stopAudio(peer);
	}

	// --- playing and levels ---

	play(peer, stream) {
		const audio = (peer.audio ??= this.makeAudio());
		audio.srcObject = stream;
		this.applyVolume(peer);
		const played = audio.play?.();
		played?.catch?.(() => {
			// Autoplay refused: the room bar offers a tap.
			this.blocked = true;
			this.changed();
		});
		peer.level = this.analyse(stream);
	}

	makeAudio() {
		if (!this.root) {
			this.root = document.createElement('div');
			this.root.className = 'voice-audio';
			document.body.append(this.root);
		}
		const audio = document.createElement('audio');
		audio.autoplay = true;
		this.root.append(audio);
		return audio;
	}

	stopAudio(peer) {
		peer.speaking = false;
		peer.since = 0;
		disconnect(peer.level);
		peer.level = null;
		if (!peer.audio) return;
		peer.audio.srcObject = null;
		peer.audio.remove();
		peer.audio = null;
	}

	applyVolume(peer) {
		if (!peer.audio) return;
		peer.audio.volume = this.volumeOf(peer.deviceId);
		peer.audio.muted = this.mutedFor(peer.deviceId);
	}

	/** The others play through <audio> elements, so the browser's echo cancellation sees them; this only reads levels. */
	analyse(stream) {
		const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
		if (!Ctx || !stream) return null;
		try {
			this.audioCtx ??= new Ctx();
			const source = this.audioCtx.createMediaStreamSource(stream);
			const analyser = this.audioCtx.createAnalyser();
			analyser.fftSize = 512;
			source.connect(analyser); // not connected to the output: nothing here plays
			return { source, analyser, data: new Uint8Array(analyser.fftSize) };
		} catch {
			return null; // no levels then; everything else works
		}
	}

	startLevels() {
		const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
		if (this.levelTimer || !Ctx) return; // no Web Audio: everything works, without the speaking marks
		this.levelTimer = setInterval(() => this.tick(), LEVEL_EVERY);
	}

	stopLevels() {
		clearInterval(this.levelTimer);
		this.levelTimer = null;
		disconnect(this.localLevel);
	}

	tick() {
		const now = Date.now();
		let changed = false;
		const mark = (holder, loud) => {
			if (loud) holder.since = now;
			const speaking = holder.since > 0 && now - holder.since < SPEAKING_HOLD;
			if (speaking === holder.speaking) return;
			holder.speaking = speaking;
			changed = true;
		};
		mark(this.self, !this.muted && level(this.localLevel) > SPEAKING_LEVEL);
		for (const peer of this.peers.values()) {
			if (peer.level) mark(peer, !peer.muted && !this.mutedFor(peer.deviceId) && level(peer.level) > SPEAKING_LEVEL);
		}
		if (changed) this.changed();
	}

	/** After the browser refused to play: a tap is the gesture it wanted. */
	async resumeAudio() {
		this.blocked = false;
		try {
			await this.audioCtx?.resume?.();
		} catch {
			// it stays suspended; levels are the only thing that needs it
		}
		for (const peer of this.peers.values()) {
			try {
				await peer.audio?.play?.();
			} catch {
				this.blocked = true;
			}
		}
		this.changed();
	}

	// --- settings ---

	setVolume(deviceId, volume) {
		this.updatePeerPrefs(deviceId, { volume: clamp(volume) });
	}

	setPeerMuted(deviceId, muted) {
		this.updatePeerPrefs(deviceId, { muted: muted === true });
	}

	updatePeerPrefs(deviceId, patch) {
		const peers = { ...this.prefs.peers, [deviceId]: { volume: 1, muted: false, ...this.prefs.peers[deviceId], ...patch } };
		this.savePrefs({ peers });
		for (const peer of this.peers.values()) if (peer.deviceId === deviceId) this.applyVolume(peer);
		this.changed();
	}

	async microphones() {
		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			return devices
				.filter(device => device.kind === 'audioinput')
				.map((device, i) => ({ id: device.deviceId, label: device.label || `Microphone ${i + 1}` }));
		} catch {
			return [];
		}
	}

	/** A listener that wants to be heard after all: ask for the microphone and take part. */
	async useMicrophone() {
		if (!this.active || this.stream) return null;
		let stream;
		try {
			stream = await this.capture();
		} catch (err) {
			return micError(err);
		}
		this.stream = stream;
		this.muted = false;
		for (const peer of this.peers.values()) this.endCall(peer); // those calls carried one voice only
		disconnect(this.localLevel);
		this.localLevel = this.analyse(stream);
		this.startLevels();
		this.announce();
		for (const peer of this.peers.values()) this.sync(peer);
		this.changed();
		return null;
	}

	/** Switch microphone (a Bluetooth headset appears as another device) without remaking the calls. */
	async setMicrophone(deviceId) {
		this.savePrefs({ mic: deviceId || null });
		if (!this.active) return null;
		let stream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: { ...CAPTURE, deviceId: { exact: deviceId } } });
		} catch (err) {
			return micError(err);
		}
		const had = Boolean(this.stream);
		const old = this.stream;
		this.stream = stream;
		this.muted = this.muted && had; // a listener that now has a microphone starts unmuted
		for (const track of stream.getAudioTracks()) track.enabled = !this.muted;
		const [track] = stream.getAudioTracks();
		for (const peer of this.peers.values()) {
			// A listener had nothing to replace: those calls have to be made again.
			if (!had) this.endCall(peer);
			else await replaceTrack(peer.call, track);
		}
		stopStream(old);
		disconnect(this.localLevel);
		this.localLevel = this.analyse(stream);
		this.startLevels();
		this.announce();
		for (const peer of this.peers.values()) this.sync(peer);
		this.changed();
		return null;
	}

	savePrefs(patch) {
		this.prefs = { ...this.prefs, ...patch };
		writeJSON(PREFS_KEY, this.prefs);
	}

	changed() {
		this.emit('change');
	}
}

async function replaceTrack(call, track) {
	const sender = call?.peerConnection?.getSenders?.().find(s => s.track?.kind === 'audio');
	if (!sender?.replaceTrack) return;
	try {
		await sender.replaceTrack(track);
	} catch (err) {
		console.warn('[peerkit] could not switch the microphone in a call', err);
	}
}

function level(entry) {
	if (!entry) return 0;
	const { analyser, data } = entry;
	analyser.getByteTimeDomainData(data);
	let sum = 0;
	for (const value of data) {
		const x = (value - 128) / 128;
		sum += x * x;
	}
	return Math.sqrt(sum / data.length);
}

function disconnect(entry) {
	try {
		entry?.source.disconnect();
	} catch {
		// the context is already closed
	}
}

const stopStream = stream => stream?.getTracks().forEach(track => track.stop());

const clamp = value => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1);

function micError(err) {
	switch (err?.name) {
		case 'NotAllowedError':
		case 'SecurityError':
			return 'The microphone is blocked, so you are only listening. Allow it in the browser’s site settings.';
		case 'NotReadableError':
		case 'AbortError':
			return 'The microphone is busy, so you are only listening. Close other apps that use it.';
		default:
			return 'No microphone here, so you are only listening.';
	}
}

/** Everything read back from storage is untrusted: volumes, mutes and the remembered microphone. */
function loadPrefs() {
	const raw = readJSON(PREFS_KEY);
	const peers = {};
	if (raw?.peers && typeof raw.peers === 'object') {
		for (const [deviceId, value] of Object.entries(raw.peers).slice(0, 50)) {
			if (deviceId.length > 64 || !value || typeof value !== 'object') continue;
			peers[deviceId] = { volume: clamp(value.volume), muted: value.muted === true };
		}
	}
	return { mic: typeof raw?.mic === 'string' && raw.mic.length <= 200 ? raw.mic : null, peers };
}
