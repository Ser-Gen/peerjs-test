import { musicSdp } from '../mediacall.js';
import { CH } from '../protocol.js';
import { button, h, icon, toast } from '../ui/dom.js';
import { randomId, readJSON, wakeLock, writeJSON } from '../util.js';
import { MarkLayer, MarkOutbox, readMark, readPeerId } from './stream-marks.js';

const PREFS_KEY = 'peerkit.stream';
const RESUME_KEY = 'peerkit.stream.resume'; // sessionStorage: what this tab shared before a reload
const GRACE = 30000; // how long a viewer keeps a stream whose sender's link dropped, waiting for it to come back
const RESOLUTIONS = { '480p': [854, 480], '720p': [1280, 720], '1080p': [1920, 1080] };
const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
// System audio is music and video sound, not a voice: no processing. restrictOwnAudio (where supported)
// keeps this page's own playback, such as the other device's camera sound, out of the capture.
const SCREEN_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true };
const KINDS = ['camera', 'screen'];
const KIND_NOUN = { camera: 'camera', screen: 'screen' };
const MAX_INCOMING = 16; // streams shown at once; 8 members with a camera and a screen each
const STATS_EVERY = 2000;
const MIN_BITRATE = 150000; // a cap never goes below this; the congestion control can still go lower on its own
const TOP_BITRATE = { camera: 2500000, screen: 4000000 }; // a cap raised past this is taken off
const RAISE_AFTER = 5; // samples without a bandwidth limit before a lowered cap goes up again
const CROWD = 2; // a phone's camera drops to 480p with more viewers than this: every call is an encoder of its own

/*
 * Streams go to the whole room. A member can share a camera and a screen at the same time; each goes to every
 * other member over a media call of its own (app/mediacall.js, metadata {id, kind}), and the viewer answers
 * without a stream. A member who arrives later gets the streams already running.
 *
 * Protocol (ch: 'stream'):
 *   start {id, kind}   sender → a member: this stream is on, a call follows (to everyone when it starts, and to
 *                      each member whose link comes up)
 *   stop  {id}         sender → everyone: it ended
 *   watch {id}         viewer → sender: call me again (a stream this viewer closed, or a call that gave up)
 *   mark  {id, …}      a viewer's pointer and strokes on a stream (app/tools/stream-marks.js): viewer → sender, and
 *                      the sender passes them on to its other viewers with `by`; the sender's own Clear → its viewers
 * A viewer that closes a stream closes its call, which tells the sender (app/mediacall.js); the others keep it.
 * A dropped link ends the call; the viewer keeps the stream paused for GRACE, and the sender calls again with the
 * same id when the link is back. A viewer that has it closed closes that call again.
 *
 * Marks go through the sender because every viewer is linked to it, and it knows who watches: a member that closed
 * the stream gets none. A web page can't draw on the sender's real screen, so it sees them on its preview only.
 */

export default {
	id: 'stream',
	title: 'Stream',
	supported: () => typeof RTCPeerConnection === 'function',
	mount(el, room, ctx) {
		const tool = new StreamTool(el, room, ctx);
		return () => tool.destroy();
	},
};

// Capture needs a secure context; receiving works anywhere.
const canCapture = () => Boolean(navigator.mediaDevices?.getUserMedia);
// Android Chrome has no screen capture.
const canShareScreen = () => Boolean(navigator.mediaDevices?.getDisplayMedia) && !/Android|iPhone|iPad/i.test(navigator.userAgent);
const coarse = () => matchMedia('(pointer: coarse)').matches;

function loadPrefs() {
	const raw = readJSON(PREFS_KEY);
	return {
		res: Object.hasOwn(RESOLUTIONS, raw?.res) ? raw.res : '720p',
		mic: raw?.mic !== false,
		// Phones usually show the others what is in front of them.
		facing: raw?.facing === 'user' || raw?.facing === 'environment' ? raw.facing : coarse() ? 'environment' : 'user',
	};
}

function readResume() {
	try {
		return (sessionStorage.getItem(RESUME_KEY) ?? '').split(',').filter(kind => KINDS.includes(kind));
	} catch {
		return [];
	}
}

function writeResume(kinds) {
	try {
		if (kinds.length) sessionStorage.setItem(RESUME_KEY, kinds.join(','));
		else sessionStorage.removeItem(RESUME_KEY);
	} catch {
		// the resume offer is a convenience
	}
}

function videoConstraints({ facing = null, deviceId = null, res }) {
	const [width, height] = RESOLUTIONS[res] ?? RESOLUTIONS['720p'];
	return {
		...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: facing ?? 'user' } }),
		width: { ideal: width },
		height: { ideal: height },
		frameRate: { ideal: 30 },
	};
}

const getVideo = options => navigator.mediaDevices.getUserMedia({ video: videoConstraints(options) });

async function getCamera({ facing, res }) {
	const video = videoConstraints({ facing, res });
	try {
		return await navigator.mediaDevices.getUserMedia({ video, audio: AUDIO });
	} catch (err) {
		// No microphone, or only the microphone is blocked: share video alone.
		try {
			return await navigator.mediaDevices.getUserMedia({ video });
		} catch {
			throw err;
		}
	}
}

function mediaError(err, kind) {
	const what = kind === 'screen' ? 'screen sharing' : 'the camera';
	switch (err?.name) {
		case 'NotAllowedError':
		case 'SecurityError':
			return `Access to ${what} is blocked. Allow it in the browser’s site settings.`;
		case 'NotFoundError':
		case 'OverconstrainedError':
			return kind === 'screen' ? 'Screen sharing is not available.' : 'No camera found.';
		case 'NotReadableError':
		case 'AbortError':
			return kind === 'screen' ? 'Could not capture the screen.' : 'The camera is busy. Close other apps that use it.';
		default:
			return `Could not start ${what}.`;
	}
}

const callOptions = kind => (kind === 'screen' ? { sdpTransform: musicSdp } : {});

const stopTracks = stream => stream?.getTracks().forEach(track => track.stop());

const readId = id => (typeof id === 'string' && /^[0-9a-z]{1,32}$/.test(id) ? id : null);

function closeCall(item) {
	const call = item.call;
	item.call = null;
	try {
		call?.close();
	} catch {
		// already closed
	}
}

function iconButton(name, label, onclick, { disabled = false, pressed = null } = {}) {
	return h('button', {
		type: 'button',
		class: 'icon-btn',
		title: label,
		'aria-label': label,
		'aria-pressed': pressed == null ? null : String(pressed),
		disabled,
		onclick,
	}, icon(name));
}

function formatRate(bps) {
	return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbit/s` : `${Math.round(bps / 1e3)} kbit/s`;
}

const videoSender = call => call?.peerConnection?.getSenders?.().find(sender => sender.track?.kind === 'video') ?? null;

class StreamTool {
	constructor(root, room, ctx) {
		this.room = room;
		this.ctx = ctx;
		this.prefs = loadPrefs();
		this.outs = new Map(); // kind → { id, kind, stream, preview, viewers: Map peerId → viewer, rate, limited, lowered, locked }
		this.ins = new Map(); // id → { id, kind, from, fromDevice, fromName, call, stream, state, seen, muted, unfollow, timer, locked, tile, video, panel }
		this.focused = null; // the id of the stream shown large in the grid
		this.soundOn = false;
		this.busy = false; // waiting for a capture prompt or a camera switch
		this.cameraCount = 0;
		this.resume = readResume();
		this.statsTimer = null;
		this.barKey = null;

		this.grid = h('div', { class: 'stream-grid' });
		this.previews = h('div', { class: 'previews' });
		this.message = h('div', { class: 'stage-message' });
		this.stage = h('div', { class: 'stage' }, this.grid, this.message, this.previews);
		this.closedBar = h('div', { class: 'stream-closed' });
		this.resumeBar = h('div', { class: 'stream-resume', role: 'status' });
		this.bar = h('div', { class: 'stream-bar' });
		this.el = h('div', { class: 'stream' }, this.closedBar, this.stage, this.resumeBar, this.bar);
		root.append(this.el);

		this.onFullscreen = () => {
			if (!document.fullscreenElement) screen.orientation?.unlock?.();
			this.render();
		};
		document.addEventListener('fullscreenchange', this.onFullscreen);

		this.unsubscribe = [
			room.on(`msg:${CH.STREAM}`, (msg, member) => this.onMessage(msg, member)),
			room.on('call', (call, member) => this.onCall(call, member)),
			room.on('link-up', member => this.onLinkUp(member)),
			room.on('link-down', member => this.onLinkDown(member)),
			room.on('members', () => {
				this.renameSelf();
				this.render();
			}),
			// While the room's voice is on it owns the microphone: a camera must not send it a second time.
			ctx?.onVoiceChange?.(() => {
				this.applyMic();
				this.render();
			}),
			// Wide window or narrow: each stream gets a panel of its own, or a tile in the grid.
			ctx?.onLayout?.(() => {
				this.place();
				this.render();
			}),
		].filter(Boolean);
		this.render();
	}

	destroy() {
		this.unsubscribe.forEach(fn => fn());
		document.removeEventListener('fullscreenchange', this.onFullscreen);
		for (const kind of [...this.outs.keys()]) this.stopOutgoing(kind, { keepResume: true });
		for (const inc of [...this.ins.values()]) this.removeIncoming(inc);
		clearInterval(this.statsTimer);
		this.el.remove();
	}

	get docked() {
		return this.ctx?.docked?.() === true;
	}

	/** The room's voice carries this device's microphone; a camera stream then sends video only. */
	get voiceOn() {
		return this.ctx?.voiceActive?.() === true;
	}

	applyMic() {
		const on = this.prefs.mic && !this.voiceOn;
		for (const track of this.outs.get('camera')?.stream.getAudioTracks() ?? []) track.enabled = on;
	}

	onLinkUp(member) {
		// A newcomer, or a member back after a drop: it gets every stream this device is sending.
		for (const out of this.outs.values()) this.offer(out, member);
		this.render();
	}

	onLinkDown(member) {
		for (const out of this.outs.values()) this.dropViewer(out, member.peerId);
		for (const inc of this.ins.values()) if (inc.from === member.peerId) this.pauseIncoming(inc);
		this.render();
	}

	/** A member renamed itself: tiles, panels and chips name the sender as it is called now. */
	renameSelf() {
		for (const inc of this.ins.values()) {
			const sender = this.room.member(inc.from);
			if (!sender || sender.name === inc.fromName) continue;
			inc.fromName = sender.name;
			inc.panel?.setTitle?.(this.titleOf(inc));
		}
	}

	savePrefs(patch) {
		this.prefs = { ...this.prefs, ...patch };
		writeJSON(PREFS_KEY, this.prefs);
	}

	// --- outgoing ---

	async startCamera() {
		if (this.busy) return;
		this.busy = true;
		this.render();
		try {
			const stream = await getCamera(this.prefs);
			stream.getVideoTracks()[0].contentHint = 'motion';
			for (const track of stream.getAudioTracks()) track.enabled = this.prefs.mic && !this.voiceOn;
			this.beginOutgoing('camera', stream);
			this.countCameras();
		} catch (err) {
			console.warn('[peerkit] camera failed', err);
			toast(mediaError(err, 'camera'));
		} finally {
			this.busy = false;
			this.render();
		}
	}

	async startScreen() {
		if (this.busy) return;
		this.busy = true;
		this.render();
		try {
			// Nothing may be awaited before this call: it needs the click's user activation.
			const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: SCREEN_AUDIO });
			stream.getVideoTracks()[0].contentHint = 'detail';
			for (const track of stream.getAudioTracks()) track.contentHint = 'music';
			this.beginOutgoing('screen', stream);
		} catch (err) {
			// Cancelling the picker is a NotAllowedError too.
			if (err?.name !== 'NotAllowedError') toast(mediaError(err, 'screen'));
		} finally {
			this.busy = false;
			this.render();
		}
	}

	start(kind) {
		return kind === 'screen' ? this.startScreen() : this.startCamera();
	}

	async countCameras() {
		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			this.cameraCount = devices.filter(d => d.kind === 'videoinput').length;
			this.render();
		} catch {
			// no switch button then
		}
	}

	beginOutgoing(kind, stream) {
		this.stopOutgoing(kind);
		const preview = h('video', { class: 'preview', playsinline: true, autoplay: true, muted: true, disablepictureinpicture: true });
		preview.muted = true;
		preview.srcObject = stream;
		const marks = new MarkLayer(preview, {
			whoOf: by => this.whoOf(by),
			mirrored: () => preview.classList.contains('mirror'),
			onChange: () => this.renderStats(),
		});
		const box = h('div', { class: 'preview-box', 'data-kind': kind }, preview, marks.el);
		const out = { id: randomId(4), kind, stream, preview, box, marks, noted: false, viewers: new Map(), rate: 0, limited: false, lowered: false, locked: false };
		this.outs.set(kind, out);
		this.previews.append(box); // appended, never moved: moving a video element pauses it
		for (const track of stream.getVideoTracks()) this.watchTrack(out, track);
		this.lock(out);
		this.resume = this.resume.filter(other => other !== kind);
		writeResume([...this.outs.keys()]);
		// With nobody here yet it waits: onLinkUp gives it to whoever arrives.
		for (const member of this.room.members) this.offer(out, member);
		this.statsTimer ??= setInterval(() => this.sample(), STATS_EVERY);
		this.render();
	}

	/** The browser's own "Stop sharing", an unplugged camera or revoked permission end the track. */
	watchTrack(out, track) {
		track.addEventListener('ended', () => {
			if (this.outs.get(out.kind) === out && out.stream.getVideoTracks().includes(track)) this.stopOutgoing(out.kind);
		});
	}

	/** Tell a member the stream is on, and send it. */
	offer(out, member) {
		this.room.send(CH.STREAM, { type: 'start', id: out.id, kind: out.kind }, member.peerId);
		this.callViewer(out, member);
	}

	callViewer(out, member) {
		this.dropViewer(out, member.peerId);
		const call = this.room.call(member.peerId, out.stream, { id: out.id, kind: out.kind }, callOptions(out.kind));
		if (!call) return; // the link isn't up: link-up offers it again
		const viewer = { peerId: member.peerId, call, bytes: 0, time: 0, rate: 0, cap: null, calm: 0 };
		out.viewers.set(member.peerId, viewer);
		call.on('close', () => {
			if (out.viewers.get(member.peerId) !== viewer) return;
			out.viewers.delete(member.peerId);
			this.forgetMarks(out, member.peerId);
			this.fitCamera(out);
			this.render();
		});
		call.on('error', err => console.warn('[peerkit] media call error', err));
		this.fitCamera(out);
	}

	dropViewer(out, peerId) {
		const viewer = out.viewers.get(peerId);
		if (!viewer) return;
		out.viewers.delete(peerId);
		closeCall(viewer);
		this.forgetMarks(out, peerId);
		this.fitCamera(out);
	}

	stopOutgoing(kind, { notify = true, keepResume = false } = {}) {
		const out = this.outs.get(kind);
		if (!out) return;
		this.outs.delete(kind);
		if (notify) this.room.send(CH.STREAM, { type: 'stop', id: out.id });
		for (const viewer of out.viewers.values()) closeCall(viewer);
		out.viewers.clear();
		stopTracks(out.stream);
		this.unlock(out);
		out.preview.srcObject = null;
		out.marks.destroy();
		out.box.remove();
		if (!keepResume) writeResume([...this.outs.keys()]);
		if (!this.outs.size) {
			clearInterval(this.statsTimer);
			this.statsTimer = null;
		}
		this.render();
	}

	toggleMic() {
		const tracks = this.outs.get('camera')?.stream.getAudioTracks() ?? [];
		if (!tracks.length) return;
		if (this.voiceOn) {
			toast('Your microphone goes through the room’s voice');
			return;
		}
		const on = !tracks[0].enabled;
		for (const track of tracks) track.enabled = on;
		this.savePrefs({ mic: on });
		this.render();
	}

	async switchCamera() {
		const out = this.outs.get('camera');
		if (!out || this.busy) return;
		const settings = out.stream.getVideoTracks()[0]?.getSettings() ?? {};
		if (settings.facingMode) {
			const facing = settings.facingMode === 'environment' ? 'user' : 'environment';
			this.savePrefs({ facing });
			await this.replaceVideo(out, { facing }, settings.deviceId);
			return;
		}
		// Desktop cameras have no facing mode: go to the next device.
		const cameras = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
		if (cameras.length < 2) return toast('No other camera found');
		const next = cameras[(cameras.findIndex(c => c.deviceId === settings.deviceId) + 1) % cameras.length];
		await this.replaceVideo(out, { deviceId: next.deviceId }, settings.deviceId);
	}

	/** The resolution the camera runs at: the chosen one, or 480p on a phone sending to many. */
	resOf(out) {
		return out.lowered && this.prefs.res !== '480p' ? '480p' : this.prefs.res;
	}

	async setResolution(res) {
		this.savePrefs({ res });
		const out = this.outs.get('camera');
		if (!out || this.busy) return;
		await this.applyResolution(out);
		this.render();
	}

	async applyResolution(out) {
		const track = out.stream.getVideoTracks()[0];
		if (!track) return;
		const [width, height] = RESOLUTIONS[this.resOf(out)];
		try {
			await track.applyConstraints({ width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } });
		} catch {
			const { deviceId } = track.getSettings();
			await this.replaceVideo(out, { deviceId }, deviceId);
		}
	}

	/** A phone encodes one copy of its camera per viewer and gets hot: past CROWD viewers it goes down to 480p. */
	fitCamera(out) {
		if (out.kind !== 'camera' || !coarse() || this.outs.get('camera') !== out) return;
		const crowd = out.viewers.size > CROWD;
		if (crowd === out.lowered) return;
		out.lowered = crowd;
		if (this.prefs.res !== '480p' && !this.busy) this.applyResolution(out).catch(() => {});
	}

	/** Swap the camera track on every call without new calls, so the viewers' video keeps playing. */
	async replaceVideo(out, target, fallbackDeviceId) {
		this.busy = true;
		this.render();
		const old = out.stream.getVideoTracks()[0];
		old?.stop(); // many phones can't open a second camera while one is on
		try {
			let stream;
			try {
				stream = await getVideo({ ...target, res: this.resOf(out) });
			} catch (err) {
				toast(mediaError(err, 'camera'));
				if (!fallbackDeviceId) throw err;
				stream = await getVideo({ deviceId: fallbackDeviceId, res: this.resOf(out) });
			}
			if (this.outs.get(out.kind) !== out) return stopTracks(stream);
			const [track] = stream.getVideoTracks();
			track.contentHint = 'motion';
			if (old) out.stream.removeTrack(old);
			out.stream.addTrack(track);
			this.watchTrack(out, track);
			await Promise.all([...out.viewers.values()].map(viewer => videoSender(viewer.call)?.replaceTrack(track).catch(() => {})));
			out.preview.srcObject = null; // re-attach so the preview picks up the new track
			out.preview.srcObject = out.stream;
		} catch (err) {
			console.warn('[peerkit] camera switch failed', err);
			if (this.outs.get(out.kind) === out) this.stopOutgoing(out.kind);
		} finally {
			this.busy = false;
			this.render();
		}
	}

	// --- upload: rate, and each viewer's cap ---

	/**
	 * Every viewer is a call with a congestion control of its own, all of them on this device's one upload. When
	 * a call says its picture is held back by bandwidth, its cap goes below what it gets through now, so the
	 * encoder makes a softer picture on purpose instead of the network dropping frames; after a calm while it
	 * goes up again, and past the top it is taken off.
	 */
	async sample() {
		for (const out of [...this.outs.values()]) {
			let rate = 0;
			let limited = false;
			for (const viewer of [...out.viewers.values()]) {
				const pc = viewer.call?.peerConnection;
				if (typeof pc?.getStats !== 'function') continue;
				let report;
				try {
					report = await pc.getStats();
				} catch {
					continue;
				}
				let bytes = 0;
				let squeezed = false;
				report.forEach(stat => {
					if (stat.type !== 'outbound-rtp') return;
					bytes += stat.bytesSent ?? 0;
					if (stat.kind === 'video' && stat.qualityLimitationReason === 'bandwidth') squeezed = true;
				});
				const now = Date.now();
				if (viewer.time && now > viewer.time) viewer.rate = Math.max(0, ((bytes - viewer.bytes) * 8000) / (now - viewer.time));
				viewer.bytes = bytes;
				viewer.time = now;
				rate += viewer.rate;
				limited ||= squeezed;
				await this.adapt(out, viewer, squeezed);
			}
			out.rate = rate;
			out.limited = limited;
		}
		this.renderStats();
	}

	async adapt(out, viewer, squeezed) {
		let cap = viewer.cap;
		if (squeezed) {
			viewer.calm = 0;
			const below = Math.max(MIN_BITRATE, Math.round(viewer.rate * 0.85));
			if (!viewer.rate || (cap && below >= cap)) return;
			cap = below;
		} else {
			if (!cap || ++viewer.calm < RAISE_AFTER) return;
			viewer.calm = 0;
			cap = Math.round(cap * 1.25);
			if (cap > TOP_BITRATE[out.kind]) cap = null;
		}
		const sender = videoSender(viewer.call);
		if (typeof sender?.getParameters !== 'function') return;
		try {
			const params = sender.getParameters();
			if (!params.encodings?.length) params.encodings = [{}];
			if (cap) params.encodings[0].maxBitrate = cap;
			else delete params.encodings[0].maxBitrate;
			await sender.setParameters(params);
			viewer.cap = cap;
		} catch (err) {
			console.warn('[peerkit] could not cap a stream', err);
		}
	}

	// --- incoming ---

	onMessage(msg, member) {
		const id = readId(msg.id);
		if (!id) return;
		switch (msg.type) {
			case 'start':
				this.expectIncoming(id, msg.kind === 'screen' ? 'screen' : 'camera', member);
				break;
			case 'stop': {
				const inc = this.ins.get(id);
				if (inc?.from === member.peerId) this.endIncoming(inc);
				break;
			}
			case 'watch': {
				const out = [...this.outs.values()].find(o => o.id === id);
				if (!out || out.viewers.has(member.peerId)) break;
				this.callViewer(out, member);
				this.render();
				break;
			}
			case 'mark': {
				const mark = readMark(msg);
				if (mark) this.onMark(id, mark, msg.by, member);
				break;
			}
		}
	}

	// --- marks: pointers and strokes on a stream ---

	/** Name and colour of whoever made a mark: a member, or this device. */
	whoOf(by) {
		const member = by === 'self' ? this.room.self : this.room.member(by);
		return { name: member?.name ?? 'Someone', color: member?.color ?? '#868e96' };
	}

	onMark(id, mark, by, member) {
		const out = [...this.outs.values()].find(o => o.id === id);
		if (out) {
			// A viewer's marks: shown on the preview, and passed on to the others watching.
			if (!out.viewers.has(member.peerId)) return;
			out.marks.apply(member.peerId, mark);
			this.relayMark(out, { ...mark, by: member.peerId }, member.peerId);
			if (out.kind === 'screen' && !out.noted && (mark.pt || mark.st)) {
				out.noted = true;
				toast('Viewers’ marks show on your preview here, not on your real screen');
			}
			return;
		}
		// From the sender: its own Clear, or a viewer's marks it passes on.
		const inc = this.ins.get(id);
		if (!inc || inc.from !== member.peerId || inc.state === 'closed' || inc.state === 'ended') return;
		const author = by === undefined ? member.peerId : readPeerId(by);
		if (!author || author === this.room.self.peerId) return;
		inc.marks.apply(author, mark);
	}

	relayMark(out, mark, except = null) {
		for (const peerId of out.viewers.keys()) if (peerId !== except) this.room.send(CH.STREAM, { type: 'mark', id: out.id, ...mark }, peerId);
	}

	/** A viewer went: its pointer goes, here and on the others. */
	forgetMarks(out, peerId) {
		if (!out.marks.pointers.has(peerId)) return;
		out.marks.unpoint(peerId);
		this.relayMark(out, { pt: null, by: peerId });
	}

	clearOutgoing(out) {
		out.marks.clear();
		this.relayMark(out, { clear: true });
	}

	setMarkMode(inc, mode) {
		inc.outbox ??= new MarkOutbox(mark => {
			if (this.ins.get(inc.id) === inc && this.room.member(inc.from)) this.room.send(CH.STREAM, { type: 'mark', id: inc.id, ...mark }, inc.from);
		});
		inc.marks.setMode(inc.marks.mode === mode ? null : mode, inc.outbox);
		this.render();
	}

	clearIncoming(inc) {
		inc.marks.clear();
		inc.outbox?.clear();
	}

	/** Announced on the control channel, just before the call. */
	expectIncoming(id, kind, member) {
		const known = this.ins.get(id);
		if (known) {
			if (known.from !== member.peerId && known.fromDevice !== member.deviceId) return null; // another member's id
			known.from = member.peerId; // the same stream after a reconnect, or a reload of this page's sender
			known.fromName = member.name;
			return known;
		}
		if (this.ins.size >= MAX_INCOMING) return null;
		const inc = {
			id, kind, from: member.peerId, fromDevice: member.deviceId, fromName: member.name,
			call: null, stream: null, state: 'connecting', seen: false, muted: false, unfollow: null, timer: null, locked: false, panel: null,
		};
		this.makeTile(inc);
		this.ins.set(id, inc);
		this.lock(inc);
		this.place();
		if (!this.docked) this.ctx?.activate?.(); // a panel of its own comes to the front by itself
		this.ctx?.notify?.();
		this.render();
		return inc;
	}

	onCall(call, member) {
		const meta = call.metadata ?? {};
		if (meta.kind !== 'camera' && meta.kind !== 'screen') return; // a 'voice' call belongs to app/voice.js
		const id = readId(meta.id);
		const inc = id && this.expectIncoming(id, meta.kind, member);
		if (!inc || inc.state === 'closed') {
			call.close(); // closed here, and called again after a drop: the sender hears it from the call
			return;
		}
		closeCall(inc);
		clearTimeout(inc.timer);
		this.lock(inc); // released if it had ended before the sender came back
		inc.call = call;
		inc.state = 'connecting';
		inc.seen = false;
		call.on('stream', stream => {
			if (this.ins.get(id) !== inc || inc.call !== call) return;
			// Fires once per track, with the same stream.
			if (inc.video.srcObject !== stream) inc.video.srcObject = stream;
			inc.stream = stream;
			inc.state = 'playing';
			this.follow(inc, stream);
			this.render();
			this.play(inc);
		});
		call.on('close', () => {
			if (this.ins.get(id) !== inc || inc.call !== call || inc.state === 'ended' || inc.state === 'closed') return;
			inc.call = null;
			if (!this.room.member(inc.from)) return this.pauseIncoming(inc);
			// The sender is still here, but the call gave up (no network route): a try again is one tap.
			inc.state = 'lost';
			inc.unfollow?.();
			this.render();
		});
		call.on('error', err => console.warn('[peerkit] media call error', err));
		call.answer(undefined, callOptions(inc.kind)); // receive only
		this.render();
	}

	/**
	 * The call hands over its tracks as soon as it is negotiated, before a single frame has come through: a
	 * video track is `muted` until then. Until it unmutes the tile keeps saying it is connecting, instead of
	 * showing a black picture as if the stream were there. Once seen, a later mute (a still screen sends
	 * nothing) keeps the picture.
	 */
	follow(inc, stream) {
		inc.unfollow?.();
		inc.unfollow = null;
		const [track] = stream?.getVideoTracks?.() ?? [];
		if (typeof track?.addEventListener !== 'function' || track.muted !== true) {
			inc.seen = true;
			return;
		}
		const onUnmute = () => {
			inc.unfollow?.();
			if (this.ins.get(inc.id) !== inc) return;
			inc.seen = true;
			this.render();
		};
		track.addEventListener('unmute', onUnmute);
		inc.unfollow = () => {
			track.removeEventListener('unmute', onUnmute);
			inc.unfollow = null;
		};
	}

	pauseIncoming(inc) {
		clearTimeout(inc.timer);
		if (inc.state === 'ended') return;
		if (inc.state === 'closed') {
			// Nothing to wait for; forget it unless the sender is back in time and says it is still on.
			inc.timer = setTimeout(() => this.removeIncoming(inc), GRACE + 5000);
			return;
		}
		inc.state = 'paused';
		inc.marks.reset();
		closeCall(inc);
		inc.timer = setTimeout(() => {
			if (this.ins.get(inc.id) === inc && inc.state === 'paused') this.endIncoming(inc);
		}, GRACE + 5000);
		this.render();
	}

	/** The sender stopped it, or never came back: the tile says so until it is closed. */
	endIncoming(inc) {
		if (inc.state === 'closed') return this.removeIncoming(inc);
		inc.state = 'ended';
		this.release(inc);
		this.render();
	}

	/**
	 * The viewer closes a stream: closing the call tells the sender, which stops sending here; the others keep it.
	 * It stays as a chip to watch again.
	 */
	closeIncoming(inc) {
		if (inc.state === 'ended') return this.removeIncoming(inc);
		inc.state = 'closed';
		this.release(inc);
		this.place();
		this.render();
	}

	/** Watch a closed stream again, or try again after the call gave up. */
	watchIncoming(inc) {
		if (!this.room.member(inc.from)) return;
		this.room.send(CH.STREAM, { type: 'watch', id: inc.id }, inc.from);
		inc.state = 'connecting';
		inc.seen = false;
		this.lock(inc);
		this.place();
		this.render();
	}

	/** Ends what plays, keeps the tile. */
	release(inc) {
		inc.marks.reset();
		inc.outbox?.destroy();
		inc.unfollow?.();
		clearTimeout(inc.timer);
		inc.timer = null;
		closeCall(inc);
		this.unlock(inc);
		this.leaveFullscreen(inc);
		inc.video.srcObject = null;
		inc.stream = null;
		if (this.focused === inc.id) this.focused = null;
	}

	removeIncoming(inc) {
		if (this.ins.get(inc.id) !== inc) return;
		this.release(inc);
		this.ins.delete(inc.id);
		inc.panel?.close();
		inc.panel = null;
		inc.marks.destroy();
		inc.tile.remove();
		this.render();
	}

	// --- where a stream is shown ---

	makeTile(inc) {
		inc.video = h('video', { class: 'remote', playsinline: true, autoplay: true, muted: true });
		inc.video.muted = true;
		inc.message = h('div', { class: 'stage-message' });
		inc.soundBtn = button('Tap for sound', 'volume-x', () => this.setSound(true), 'btn primary sound-btn');
		inc.actions = h('div', { class: 'stage-actions' });
		inc.label = h('div', { class: 'tile-label' });
		inc.marks = new MarkLayer(inc.video, { whoOf: by => this.whoOf(by), onChange: () => this.renderTile(inc, this.focusId()) });
		inc.outbox = null;
		// Kept, not made again at every render: a button replaced between press and release loses its click.
		inc.pointBtn = iconButton('pointer', 'Point', () => this.setMarkMode(inc, 'point'), { pressed: false });
		inc.drawBtn = iconButton('pencil', 'Draw', () => this.setMarkMode(inc, 'draw'), { pressed: false });
		inc.clearBtn = iconButton('eraser', 'Clear marks', () => this.clearIncoming(inc));
		inc.tile = h('div', { class: 'tile', 'data-stream': inc.id }, inc.video, inc.marks.el, inc.message, inc.soundBtn, inc.actions, inc.label);
		// A tap on the picture shows it large in the grid, and a second tap goes back.
		inc.video.addEventListener('click', () => this.toggleFocus(inc));
		for (const type of ['enterpictureinpicture', 'leavepictureinpicture']) inc.video.addEventListener(type, () => this.render());
	}

	titleOf(inc) {
		return `${inc.fromName}’s ${KIND_NOUN[inc.kind]}`;
	}

	/**
	 * Each stream is a panel of its own on a wide screen, and a tile in the Stream tab's grid otherwise. A closed
	 * one is neither: it waits as a chip.
	 */
	place() {
		const docked = this.docked;
		for (const inc of this.ins.values()) {
			if (inc.state === 'closed') {
				inc.panel?.close();
				inc.panel = null;
				inc.tile.remove();
				continue;
			}
			if (docked && !inc.panel?.open) {
				inc.panel = this.ctx.openPanel?.({ id: inc.id, title: this.titleOf(inc), el: inc.tile, onClose: () => this.closeIncoming(inc) }) ?? null;
			} else if (!docked && inc.panel) {
				inc.panel.close();
				inc.panel = null;
			}
			inc.tile.classList.toggle('in-panel', Boolean(inc.panel?.open));
			if (!inc.panel?.open && inc.tile.parentNode !== this.grid) this.grid.append(inc.tile);
			// Moving a video element pauses it.
			if (inc.state === 'playing' && inc.video.paused) inc.video.play().catch(() => {});
		}
	}

	toggleFocus(inc) {
		if (inc.panel?.open || inc.marks.mode) return;
		this.focused = this.focused === inc.id ? null : inc.id;
		this.render();
	}

	async play(inc) {
		const video = inc.video;
		video.muted = !this.soundOn || inc.muted;
		try {
			await video.play();
		} catch {
			// Sound needs a recent tap on the page; fall back to muted with "Tap for sound".
			if (!video.muted) {
				this.soundOn = false;
				video.muted = true;
				await video.play().catch(() => {});
			}
		}
		this.render();
	}

	/** "Tap for sound" turns sound on for every stream: the tap is what the browser waits for. */
	setSound(on) {
		this.soundOn = on;
		for (const inc of this.ins.values()) {
			inc.video.muted = !on || inc.muted;
			if (on && inc.state === 'playing') inc.video.play().catch(() => {});
		}
		this.render();
	}

	toggleMute(inc) {
		inc.muted = !inc.muted;
		inc.video.muted = !this.soundOn || inc.muted;
		this.render();
	}

	async toggleFullscreen(inc) {
		if (document.fullscreenElement) {
			document.exitFullscreen().catch(() => {});
			return;
		}
		try {
			await inc.tile.requestFullscreen({ navigationUI: 'hide' });
			const { videoWidth, videoHeight } = inc.video;
			if (coarse() && videoWidth > videoHeight) await screen.orientation?.lock?.('landscape')?.catch(() => {});
		} catch (err) {
			console.warn('[peerkit] fullscreen failed', err);
		}
	}

	togglePip(inc) {
		if (document.pictureInPictureElement === inc.video) document.exitPictureInPicture().catch(() => {});
		else inc.video.requestPictureInPicture().catch(() => toast('Picture-in-picture is not available'));
	}

	leaveFullscreen(inc) {
		if (document.fullscreenElement === inc.tile) document.exitFullscreen().catch(() => {});
		if (document.pictureInPictureElement === inc.video) document.exitPictureInPicture().catch(() => {});
	}

	lock(item) {
		if (item.locked) return;
		item.locked = true;
		wakeLock.acquire();
	}

	unlock(item) {
		if (!item.locked) return;
		item.locked = false;
		wakeLock.release();
	}

	// --- rendering ---

	/** The stream shown large in the grid, if any. */
	focusId() {
		const inGrid = [...this.ins.values()].filter(inc => inc.state !== 'closed' && !inc.panel?.open);
		if (this.focused && !inGrid.some(inc => inc.id === this.focused)) this.focused = null;
		return inGrid.length > 1 ? this.focused : null;
	}

	render() {
		const incs = [...this.ins.values()];
		const inGrid = incs.filter(inc => inc.state !== 'closed' && !inc.panel?.open);
		const focus = this.focusId();

		this.el.classList.toggle('has-remote', inGrid.length > 0);
		this.el.classList.toggle('has-preview', this.outs.size > 0);
		this.grid.hidden = !inGrid.length;
		this.grid.classList.toggle('focused', Boolean(focus));
		this.grid.style.setProperty('--others', String(Math.max(1, inGrid.length - 1)));
		for (const inc of incs) this.renderTile(inc, focus);

		this.previews.hidden = !this.outs.size;
		for (const out of this.outs.values()) {
			const facing = out.stream.getVideoTracks()[0]?.getSettings().facingMode;
			// Mirror yourself, as in a mirror, except the back camera.
			out.preview.classList.toggle('mirror', out.kind === 'camera' && facing !== 'environment');
		}

		this.renderMessage(inGrid, incs);
		this.renderClosed(incs);
		this.renderResume();
		this.renderBar();
	}

	renderTile(inc, focus) {
		const playing = inc.state === 'playing' && Boolean(inc.stream) && inc.seen;
		const hasAudio = playing && inc.stream.getAudioTracks().length > 0;
		inc.tile.classList.toggle('focus', focus === inc.id);
		inc.tile.dataset.state = inc.state;
		inc.video.hidden = !playing;
		inc.label.textContent = this.titleOf(inc);
		inc.label.hidden = Boolean(inc.panel?.open) && playing; // the panel's tab names it
		inc.soundBtn.hidden = !(hasAudio && !this.soundOn);

		inc.actions.hidden = inc.state === 'closed';
		if (!playing && inc.marks.mode) inc.marks.setMode(null);
		inc.pointBtn.setAttribute('aria-pressed', String(inc.marks.mode === 'point'));
		inc.drawBtn.setAttribute('aria-pressed', String(inc.marks.mode === 'draw'));
		inc.tile.classList.toggle('marking', Boolean(inc.marks.mode));
		const fullscreen = document.fullscreenElement === inc.tile;
		inc.actions.replaceChildren(...[
			playing && inc.pointBtn,
			playing && inc.drawBtn,
			playing && inc.marks.hasStrokes && inc.clearBtn,
			hasAudio && this.soundOn && iconButton(inc.muted ? 'volume-x' : 'volume', inc.muted ? 'Unmute' : 'Mute', () => this.toggleMute(inc), { pressed: inc.muted }),
			playing && document.pictureInPictureEnabled && iconButton('pip', 'Picture-in-picture', () => this.togglePip(inc)),
			playing && inc.tile.requestFullscreen && iconButton(fullscreen ? 'minimize' : 'maximize', fullscreen ? 'Exit full screen' : 'Full screen', () => this.toggleFullscreen(inc)),
			inc.state !== 'ended' && iconButton('close', `Close ${this.titleOf(inc)}`, () => this.closeIncoming(inc)),
		].filter(Boolean));

		let content = null;
		const noun = inc.kind === 'screen' ? 'screen sharing' : 'camera stream';
		if (inc.state === 'connecting' || (inc.state === 'playing' && !inc.seen)) {
			content = [h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('p', {}, `Connecting to ${this.titleOf(inc)}…`)];
		} else if (inc.state === 'paused') {
			content = [h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('p', {}, 'Paused until the connection comes back…')];
		} else if (inc.state === 'lost') {
			content = [h('p', {}, `The connection to ${this.titleOf(inc)} was lost.`), button('Try again', null, () => this.watchIncoming(inc), 'btn')];
		} else if (inc.state === 'ended') {
			content = [h('p', {}, `${inc.fromName}’s ${noun} ended`), button('Close', null, () => this.removeIncoming(inc), 'btn')];
		}
		inc.message.hidden = !content;
		if (content) inc.message.replaceChildren(...content);
	}

	renderMessage(inGrid, incs) {
		let content = null;
		if (inGrid.length || this.outs.size) {
			// the grid or the previews fill the stage
		} else if (incs.some(inc => inc.panel?.open)) {
			content = [icon('camera'), h('p', { class: 'hint' }, 'Each stream opens in a panel of its own.')];
		} else {
			content = [
				icon('camera'),
				h('p', {}, 'Share your camera or screen with the room.'),
				h('p', { class: 'hint' }, 'When someone shares, it appears here.'),
			];
		}
		this.message.hidden = !content;
		if (content) this.message.replaceChildren(...content);
	}

	/** Streams this device closed while they go on: one tap to watch again. */
	renderClosed(incs) {
		const closed = incs.filter(inc => inc.state === 'closed');
		this.closedBar.hidden = !closed.length;
		if (!closed.length) return;
		this.closedBar.replaceChildren(
			h('span', { class: 'hint' }, 'Closed:'),
			...closed.map(inc => button(`Watch ${this.titleOf(inc)}`, 'camera', () => this.watchIncoming(inc), 'btn small ghost')));
	}

	renderResume() {
		const kinds = this.resume.filter(kind => !this.outs.has(kind));
		this.resumeBar.hidden = !kinds.length;
		if (!kinds.length) return;
		const noun = kind => (kind === 'screen' ? 'screen sharing' : 'camera');
		this.resumeBar.replaceChildren(
			h('span', {}, `Your ${kinds.map(noun).join(' and ')} stopped when the page reloaded.`),
			...kinds.map(kind => button(kinds.length > 1 ? `Resume ${kind}` : 'Resume', null, () => this.start(kind), 'btn small primary')),
			iconButton('close', 'Dismiss', () => {
				this.resume = [];
				writeResume([...this.outs.keys()]);
				this.render();
			}));
	}

	/**
	 * The bar is built again only when what it holds changes; the numbers in it are updated in place every
	 * STATS_EVERY, since a button replaced between press and release loses its click.
	 */
	renderBar() {
		const camera = this.outs.get('camera');
		const audio = camera?.stream.getAudioTracks() ?? [];
		const micOn = Boolean(audio[0]?.enabled);
		const key = JSON.stringify([
			[...this.outs.values()].map(out => [out.id, out.lowered]),
			this.busy, this.cameraCount, audio.length, micOn, this.voiceOn, this.prefs.res, this.room.members.length > 0,
		]);
		if (key === this.barKey) return this.renderStats();
		this.barKey = key;

		const rows = [];
		for (const out of this.outs.values()) {
			const items = [
				out.status = h('span', { class: 'live' }),
				out.warning = h('span', { class: 'stream-warn', role: 'status' }),
			];
			if (out.kind === 'camera') {
				if (this.cameraCount > 1) items.push(iconButton('switch-camera', 'Switch camera', () => this.switchCamera()));
				items.push(iconButton(micOn ? 'mic' : 'mic-off',
					!audio.length ? 'No microphone' : this.voiceOn ? 'Your microphone goes through the room’s voice' : micOn ? 'Mute microphone' : 'Unmute microphone',
					() => this.toggleMic(),
					{ disabled: !audio.length || this.voiceOn, pressed: audio.length ? !micOn : null }));
				items.push(h('select', {
					class: 'input select',
					'aria-label': 'Resolution',
					title: out.lowered && this.prefs.res !== '480p' ? `480p while more than ${CROWD} watch` : null,
					onchange: e => this.setResolution(e.target.value),
				}, Object.keys(RESOLUTIONS).map(res => h('option', { value: res, selected: res === this.prefs.res }, res))));
			}
			out.clearBtn = iconButton('eraser', 'Clear marks', () => this.clearOutgoing(out));
			items.push(out.clearBtn, button('Stop', 'stop', () => this.stopOutgoing(out.kind), 'btn small danger'));
			rows.push(h('div', { class: 'stream-out', 'data-kind': out.kind }, ...items));
		}

		const starts = [
			!this.outs.has('camera') && button('Share camera', 'camera', () => this.startCamera(), 'btn'),
			!this.outs.has('screen') && canShareScreen() && button('Share screen', 'monitor', () => this.startScreen(), 'btn'),
		].filter(Boolean);
		const hint = !canCapture() ? 'Sharing needs HTTPS.' : !this.outs.size && !this.room.members.length ? 'You can start now: whoever joins sees it.' : null;
		if (starts.length || hint) {
			const row = h('div', { class: 'stream-start' }, ...starts, hint && h('span', { class: 'hint' }, hint));
			for (const control of row.querySelectorAll('button')) control.disabled = this.busy || !canCapture();
			rows.push(row);
		}
		this.bar.replaceChildren(...rows);
		if (this.busy) for (const control of this.bar.querySelectorAll('.stream-out button, .stream-out select')) control.disabled = true;
		this.renderStats();
	}

	/** Who is watching each stream and how much it sends; a warning when the upload can't keep up. */
	renderStats() {
		const anyone = this.room.members.length > 0;
		for (const out of this.outs.values()) {
			if (!out.status) continue;
			const what = out.kind === 'screen' ? 'your screen' : 'your camera';
			const n = out.viewers.size;
			const text = !anyone
				? `Ready to share ${what} — whoever joins sees it`
				: `Sharing ${what} · ${n ? `${n} watching` : 'nobody watching'}${n && out.rate ? ` · ${formatRate(out.rate)}` : ''}`;
			if (out.status.textContent !== text) out.status.textContent = text;
			out.status.toggleAttribute('data-waiting', !anyone || !n);
			const warning = out.limited ? 'Your upload can’t keep up: the picture is made softer' : '';
			if (out.warning.textContent !== warning) out.warning.textContent = warning;
			out.warning.hidden = !warning;
			out.clearBtn.hidden = !out.marks.hasStrokes;
		}
	}
}
