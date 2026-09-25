import { CH } from './protocol.js';
import { Emitter } from './emitter.js';
import { readJSON, wakeLock, writeJSON } from './util.js';

const PREFS_KEY = 'peerkit.voice';
const CAPTURE = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const LEVEL_EVERY = 100; // ms between level samples
const SPEAKING_LEVEL = 0.05; // RMS above which someone counts as speaking
const SPEAKING_HOLD = 400; // ms the mark stays after the level drops, so it doesn't flicker
const REDIAL_DELAY = 1000;
const REDIAL_TRIES = 5; // after this many quick tries the pair keeps trying, slowly, while both are in voice
const SLOW_REDIAL = 15000;
const CALL_TIMEOUT = 10000; // ms to wait for the audio of a call before dialing again

/*
 * Voice in the room: an open microphone with a mute button, for everyone who joins it.
 *
 * Protocol (ch: 'voice'). Media goes over a peerjs call with metadata {kind: 'voice'}.
 *   state {on, muted, mic}   the sender's voice state; sent on every link up and whenever it changes
 *   hangup {call}            the sender ended that call (its peerjs connection ID) while both stay in voice;
 *                            peerjs doesn't tell the other side, which would keep a dead call and never dial again
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
			room.on('state', () => this.onState()),
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

	/** 'waiting' | 'speaking' | 'muted' | 'on' for a member in voice, null for one who isn't. */
	mark(peerId) {
		const peer = this.peers.get(peerId);
		if (!peer?.active) return null;
		if (peer.muted) return 'muted'; // a listener is muted too
		if (peer.mic && !this.hearable(peer)) return 'waiting'; // in voice, but nothing is coming through
		return peer.speaking ? 'speaking' : 'on';
	}

	/** Their audio is here and media is actually running through it. */
	hearable(peer) {
		return Boolean(peer.audio) && peer.flowing;
	}

	/** Members in voice we cannot hear yet. A listener sends nothing, so it is never one of them. */
	get waiting() {
		return this.others.filter(peer => peer.mic && !this.hearable(peer));
	}

	/** What is happening with one member, for the voice sheet. Null when there is nothing to say. */
	statusOf(peer) {
		if (!peer.mic) return 'Listening only';
		if (!peer.call) return 'No call yet';
		if (!peer.audio) return 'Connecting…';
		if (!peer.flowing) return 'No sound coming through';
		return null;
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

	/** A call needs the signaling server: when it comes back, pick up the pairs that were left without one. */
	onState() {
		if (!this.active || this.room.state !== 'open' || this.room.signalingLost) return;
		for (const peer of this.peers.values()) {
			if (!peer.active || peer.call) continue;
			peer.tries = 0;
			this.sync(peer);
		}
	}

	onMessage(msg, member) {
		if (msg?.type === 'hangup') return this.onHangup(msg, member);
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

	/** The other side gave up on a call: drop our end too, and the side that dials calls again. */
	onHangup(msg, member) {
		const peer = this.peers.get(member.peerId);
		if (!peer?.call || typeof msg.call !== 'string' || peer.call.connectionId !== msg.call) return; // an older call
		this.endCall(peer);
		this.retry(peer);
		this.changed();
	}

	onCall(call, member) {
		if (call.metadata?.kind !== 'voice') return; // camera and screen belong to the Stream tool
		if (!this.active) {
			call.close(); // not in voice: nothing to answer with, and nothing should start playing
			this.announce(member.peerId); // they think we are in voice: say we aren't, so they stop calling
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
				flowing: false, // media is running through their audio, not just a call that exists
				unflow: null,
				tries: 0,
				timer: null,
				watch: null,
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
		// A listener sends nothing back, so only a member with a microphone is waited for.
		peer.watch = peer.mic ? setTimeout(() => this.stalled(peer, call), CALL_TIMEOUT) : null;
		call.on('stream', stream => {
			if (peer.call !== call) return;
			this.play(peer, stream); // the wait ends when media comes through it, not when it arrives
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

	/**
	 * A call that fell over, or was never made, while both sides are still in voice. A few quick tries, then
	 * one every 15 s: giving up for good would leave a pair silent with nothing to do about it but rejoin.
	 */
	retry(peer) {
		clearTimeout(peer.timer);
		peer.timer = null;
		if (!this.active || !peer.active || !this.stream) return;
		peer.tries++;
		peer.timer = setTimeout(() => {
			peer.timer = null;
			if (this.room.member(peer.peerId)) this.sync(peer);
		}, peer.tries <= REDIAL_TRIES ? REDIAL_DELAY : SLOW_REDIAL);
		this.changed();
	}

	/** A call that connected but never carried audio: half a negotiation is silence forever, so start over. */
	stalled(peer, call) {
		if (peer.call !== call) return;
		if (peer.muted) {
			// Nothing is expected from them while they are muted; keep the wait running for when they speak.
			peer.watch = setTimeout(() => this.stalled(peer, call), CALL_TIMEOUT);
			return;
		}
		const pc = call.peerConnection;
		// The state of the connection is the only clue there is when a call goes nowhere, so say it out loud.
		console.warn(`[peerkit] no audio from ${peer.name}; dialing again`,
			{ ice: pc?.iceConnectionState, connection: pc?.connectionState, signaling: pc?.signalingState });
		// The other side may be hearing us fine and have no reason to give up: it has to be told.
		this.hangUp(peer);
		this.retry(peer);
	}

	/** End a call and tell the other side which one, while both stay in voice. */
	hangUp(peer) {
		const id = peer.call?.connectionId;
		this.endCall(peer);
		if (typeof id === 'string') this.room.send(CH.VOICE, { type: 'hangup', call: id }, peer.peerId);
	}

	endCall(peer) {
		clearTimeout(peer.timer);
		clearTimeout(peer.watch);
		peer.timer = null;
		peer.watch = null;
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
		peer.level = this.analyse(tap(stream), true);
		this.follow(peer, stream);
	}

	/**
	 * A track handed over by a call is `muted` until the first media arrives through it, and says so when it
	 * does. That is the difference between a call that exists and a member who can be heard, and it is what
	 * the wait on a call ends on: a call that connects and then carries nothing is silence with no complaint.
	 */
	follow(peer, stream) {
		peer.unflow?.();
		const [track] = stream?.getAudioTracks?.() ?? [];
		if (typeof track?.addEventListener !== 'function') {
			peer.flowing = true; // nothing to go by: take the sound as being there
			this.heard(peer);
			return;
		}
		const update = () => {
			peer.flowing = track.muted !== true;
			if (peer.flowing) this.heard(peer);
			this.changed();
		};
		track.addEventListener('mute', update);
		track.addEventListener('unmute', update);
		peer.unflow = () => {
			track.removeEventListener('mute', update);
			track.removeEventListener('unmute', update);
			peer.unflow = null;
		};
		peer.flowing = track.muted !== true;
		if (peer.flowing) this.heard(peer);
	}

	/** Media has come through from this member: the call is done connecting. */
	heard(peer) {
		clearTimeout(peer.watch);
		peer.watch = null;
		peer.tries = 0;
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
		peer.unflow?.();
		peer.flowing = false;
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

	/**
	 * Read the level of a stream. `owned` means this stream was made here (a tap) and is stopped with it.
	 * The others play through <audio> elements, so the browser's echo cancellation sees them; this only reads.
	 */
	analyse(stream, owned = false) {
		const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
		if (!Ctx || !stream) return null;
		try {
			this.audioCtx ??= new Ctx();
			this.audioCtx.resume?.().catch?.(() => {}); // a context made before the tap starts suspended
			const source = this.audioCtx.createMediaStreamSource(stream);
			const analyser = this.audioCtx.createAnalyser();
			analyser.fftSize = 512;
			source.connect(analyser); // not connected to the output: nothing here plays
			return { source, analyser, data: new Uint8Array(analyser.fftSize), owned: owned ? stream : null };
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
		for (const peer of this.peers.values()) this.hangUp(peer); // those calls carried one voice only
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
			if (!had) this.hangUp(peer);
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
	stopStream(entry?.owned);
}

/*
 * A copy of a stream's audio, for reading its level.
 *
 * Chrome sends a remote stream either to a media element or into Web Audio, not to both: an AnalyserNode
 * made from the stream an <audio> element is playing takes the sound away from it, and since nothing here
 * connects to the output, the member goes silent while the speaking mark still works. So the levels read a
 * clone of the track, and the element keeps the stream it was given. Without clone() there are no marks.
 */
function tap(stream) {
	const [track] = stream?.getAudioTracks?.() ?? [];
	if (typeof track?.clone !== 'function' || typeof MediaStream !== 'function') return null;
	try {
		return new MediaStream([track.clone()]);
	} catch {
		return null;
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
