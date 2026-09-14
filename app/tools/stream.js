import { CH } from '../protocol.js';
import { button, h, icon, toast } from '../ui/dom.js';
import { randomId, readJSON, wakeLock, writeJSON } from '../util.js';

const PREFS_KEY = 'peerkit.stream';
const RESUME_KEY = 'peerkit.stream.resume'; // sessionStorage: what this tab shared before a reload or a long drop
const GRACE = 30000; // a stream survives a dropped link this long, so it can continue without a new tap
const RESOLUTIONS = { '480p': [854, 480], '720p': [1280, 720], '1080p': [1920, 1080] };
const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const KIND_NOUN = { camera: 'camera', screen: 'shared screen' };

/*
 * Protocol (ch: 'stream'). Media goes over a peerjs MediaConnection with metadata {id, kind}; the
 * receiver answers without a stream. peerjs only closes a call once ICE fails, which takes long,
 * so start and stop are also sent on the control channel.
 *   start {id, kind}   sender → receiver, just before the call
 *   stop  {id}         sender → receiver
 *   close {id}         receiver → sender: the viewer closed it, stop sending
 * After a dropped link the sender calls again with the same id; the receiver treats it as a resume.
 */

export default {
	id: 'stream',
	title: 'Stream',
	supported: () => typeof RTCPeerConnection === 'function',
	mount(el, session, ctx) {
		const tool = new StreamTool(el, session, ctx);
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
		// Phones usually show the other device what is in front of them.
		facing: raw?.facing === 'user' || raw?.facing === 'environment' ? raw.facing : coarse() ? 'environment' : 'user',
	};
}

function readResume() {
	try {
		const kind = sessionStorage.getItem(RESUME_KEY);
		return kind === 'camera' || kind === 'screen' ? kind : null;
	} catch {
		return null;
	}
}

function writeResume(kind) {
	try {
		if (kind) sessionStorage.setItem(RESUME_KEY, kind);
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

const stopTracks = stream => stream?.getTracks().forEach(track => track.stop());

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

class StreamTool {
	constructor(root, session, ctx) {
		this.session = session;
		this.ctx = ctx;
		this.prefs = loadPrefs();
		this.out = null; // { id, kind, stream, call, paused, timer, locked }
		this.in = null; // { id, kind, call, stream, state: connecting | playing | paused | ended, timer, locked }
		this.soundOn = false;
		this.busy = false; // waiting for a capture prompt or a camera switch
		this.cameraCount = 0;
		this.resume = readResume();
		this.wasConnected = false;

		this.remote = h('video', { class: 'remote', playsinline: true, autoplay: true, muted: true });
		this.remote.muted = true;
		this.preview = h('video', { class: 'preview', playsinline: true, autoplay: true, muted: true, disablepictureinpicture: true });
		this.preview.muted = true;
		this.message = h('div', { class: 'stage-message' });
		this.soundBtn = button('Tap for sound', 'volume-x', () => this.setSound(true), 'btn primary sound-btn');
		this.stageActions = h('div', { class: 'stage-actions' });
		this.stage = h('div', { class: 'stage' }, this.remote, this.message, this.soundBtn, this.stageActions, this.preview);
		this.resumeBar = h('div', { class: 'stream-resume', role: 'status' });
		this.bar = h('div', { class: 'stream-bar' });
		this.el = h('div', { class: 'stream' }, this.stage, this.resumeBar, this.bar);
		root.append(this.el);

		this.onFullscreen = () => {
			if (!document.fullscreenElement) screen.orientation?.unlock?.();
			this.render();
		};
		document.addEventListener('fullscreenchange', this.onFullscreen);
		for (const type of ['enterpictureinpicture', 'leavepictureinpicture']) this.remote.addEventListener(type, () => this.render());

		this.unsubscribe = [
			session.onMessage(CH.STREAM, msg => this.onMessage(msg)),
			session.on('call', call => this.onCall(call)),
			session.on('state', () => this.onState()),
		];
		this.onState();
	}

	destroy() {
		this.unsubscribe.forEach(fn => fn());
		document.removeEventListener('fullscreenchange', this.onFullscreen);
		this.stopOutgoing({ keepResume: true });
		this.dropIncoming();
		this.el.remove();
	}

	get connected() {
		return this.session.state === 'connected';
	}

	onState() {
		const connected = this.connected;
		if (connected !== this.wasConnected) {
			this.wasConnected = connected;
			if (connected) {
				if (this.out?.paused) this.resumeOutgoing();
			} else {
				// The session reconnects by itself; keep the capture running meanwhile.
				if (this.out && !this.out.paused) this.pauseOutgoing();
				if (this.in && this.in.state !== 'ended') this.pauseIncoming();
			}
		}
		this.render();
	}

	requireConnection() {
		if (this.connected) return true;
		toast('Not connected');
		return false;
	}

	savePrefs(patch) {
		this.prefs = { ...this.prefs, ...patch };
		writeJSON(PREFS_KEY, this.prefs);
	}

	// --- outgoing ---

	async startCamera() {
		if (this.busy || !this.requireConnection()) return;
		this.busy = true;
		this.render();
		try {
			const stream = await getCamera(this.prefs);
			if (!this.connected) return stopTracks(stream);
			stream.getVideoTracks()[0].contentHint = 'motion';
			for (const track of stream.getAudioTracks()) track.enabled = this.prefs.mic;
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
		if (this.busy || !this.requireConnection()) return;
		this.busy = true;
		this.render();
		try {
			// Nothing may be awaited before this call: it needs the click's user activation.
			const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true });
			if (!this.connected) return stopTracks(stream);
			stream.getVideoTracks()[0].contentHint = 'detail';
			this.beginOutgoing('screen', stream);
		} catch (err) {
			// Cancelling the picker is a NotAllowedError too.
			if (err?.name !== 'NotAllowedError') toast(mediaError(err, 'screen'));
		} finally {
			this.busy = false;
			this.render();
		}
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
		this.stopOutgoing();
		const out = (this.out = { id: randomId(4), kind, stream, call: null, paused: false, timer: null, locked: false });
		for (const track of stream.getVideoTracks()) this.watchTrack(out, track);
		this.lock(out);
		this.resume = null;
		writeResume(kind);
		this.preview.srcObject = stream;
		this.callRemote(out);
		this.render();
	}

	/** The browser's own "Stop sharing", an unplugged camera or revoked permission end the track. */
	watchTrack(out, track) {
		track.addEventListener('ended', () => {
			if (this.out === out && out.stream.getVideoTracks().includes(track)) this.stopOutgoing();
		});
	}

	callRemote(out) {
		this.session.send(CH.STREAM, { type: 'start', id: out.id, kind: out.kind });
		const call = this.session.call(out.stream, { id: out.id, kind: out.kind });
		if (!call) {
			toast('Could not start the stream: the signaling server is not reachable');
			this.stopOutgoing();
			return;
		}
		out.call = call;
		call.on('close', () => {
			if (out.call === call) out.call = null;
		});
		call.on('error', err => console.warn('[peerkit] media call error', err));
	}

	pauseOutgoing() {
		const out = this.out;
		out.paused = true;
		closeCall(out);
		out.timer = setTimeout(() => {
			if (this.out !== out) return;
			this.stopOutgoing({ notify: false, keepResume: true });
			this.resume = out.kind;
			this.render();
		}, GRACE);
	}

	resumeOutgoing() {
		const out = this.out;
		clearTimeout(out.timer);
		out.paused = false;
		this.callRemote(out);
	}

	stopOutgoing({ notify = true, keepResume = false } = {}) {
		const out = this.out;
		if (!out) return;
		this.out = null;
		clearTimeout(out.timer);
		if (notify) this.session.send(CH.STREAM, { type: 'stop', id: out.id });
		closeCall(out);
		stopTracks(out.stream);
		this.unlock(out);
		if (!keepResume) writeResume(null);
		this.preview.srcObject = null;
		this.render();
	}

	toggleMic() {
		const tracks = this.out?.stream.getAudioTracks() ?? [];
		if (!tracks.length) return;
		const on = !tracks[0].enabled;
		for (const track of tracks) track.enabled = on;
		this.savePrefs({ mic: on });
		this.render();
	}

	async switchCamera() {
		const out = this.out;
		if (!out || out.kind !== 'camera' || this.busy) return;
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

	async setResolution(res) {
		this.savePrefs({ res });
		const out = this.out;
		if (!out || out.kind !== 'camera' || this.busy) return;
		const track = out.stream.getVideoTracks()[0];
		const [width, height] = RESOLUTIONS[res];
		try {
			await track.applyConstraints({ width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } });
		} catch {
			const { deviceId } = track.getSettings();
			await this.replaceVideo(out, { deviceId }, deviceId);
		}
		this.render();
	}

	/** Swap the camera track without a new call, so the receiver's video keeps playing. */
	async replaceVideo(out, target, fallbackDeviceId) {
		this.busy = true;
		this.render();
		const old = out.stream.getVideoTracks()[0];
		old?.stop(); // many phones can't open a second camera while one is on
		try {
			let stream;
			try {
				stream = await getVideo({ ...target, res: this.prefs.res });
			} catch (err) {
				toast(mediaError(err, 'camera'));
				if (!fallbackDeviceId) throw err;
				stream = await getVideo({ deviceId: fallbackDeviceId, res: this.prefs.res });
			}
			if (this.out !== out) return stopTracks(stream);
			const [track] = stream.getVideoTracks();
			track.contentHint = 'motion';
			if (old) out.stream.removeTrack(old);
			out.stream.addTrack(track);
			this.watchTrack(out, track);
			const sender = out.call?.peerConnection?.getSenders().find(s => s.track === old || s.track?.kind === 'video');
			await sender?.replaceTrack(track);
			this.preview.srcObject = null; // re-attach so the preview picks up the new track
			this.preview.srcObject = out.stream;
		} catch (err) {
			console.warn('[peerkit] camera switch failed', err);
			if (this.out === out) this.stopOutgoing();
		} finally {
			this.busy = false;
			this.render();
		}
	}

	// --- incoming ---

	onMessage(msg) {
		const id = typeof msg.id === 'string' ? msg.id.slice(0, 32) : null;
		if (!id) return;
		switch (msg.type) {
			case 'start':
				this.expectIncoming(id, msg.kind === 'screen' ? 'screen' : 'camera');
				break;
			case 'stop':
				if (this.in?.id === id) this.endIncoming();
				break;
			case 'close':
				if (this.out?.id === id) {
					this.stopOutgoing({ notify: false });
					toast('The other device closed your stream');
				}
				break;
		}
	}

	/** Announced on the control channel; the call itself takes a trip through the server. */
	expectIncoming(id, kind) {
		if (this.in?.id === id) return; // the same stream resuming after a reconnect
		this.dropIncoming();
		this.in = { id, kind, call: null, stream: null, state: 'connecting', timer: null, locked: false };
		this.lock(this.in);
		this.ctx.activate();
		this.render();
	}

	onCall(call) {
		const meta = call.metadata ?? {};
		const id = typeof meta.id === 'string' ? meta.id.slice(0, 32) : randomId(4);
		this.expectIncoming(id, meta.kind === 'screen' ? 'screen' : 'camera');
		const inc = this.in;
		closeCall(inc);
		clearTimeout(inc.timer);
		this.lock(inc); // released if it had ended before the sender came back
		inc.call = call;
		inc.state = 'connecting';
		call.on('stream', stream => {
			if (this.in !== inc || inc.call !== call) return;
			// Fires once per track, with the same stream.
			if (this.remote.srcObject !== stream) this.remote.srcObject = stream;
			inc.stream = stream;
			inc.state = 'playing';
			this.render();
			this.play();
		});
		call.on('close', () => {
			if (this.in !== inc || inc.call !== call || inc.state === 'ended') return;
			inc.call = null;
			if (this.connected) this.endIncoming();
			else this.pauseIncoming();
		});
		call.on('error', err => console.warn('[peerkit] media call error', err));
		call.answer(); // receive only
		this.render();
	}

	pauseIncoming() {
		const inc = this.in;
		inc.state = 'paused';
		closeCall(inc);
		clearTimeout(inc.timer);
		inc.timer = setTimeout(() => {
			if (this.in === inc && inc.state === 'paused') this.endIncoming();
		}, GRACE + 5000);
		this.render();
	}

	endIncoming() {
		const inc = this.in;
		if (!inc) return;
		inc.state = 'ended';
		clearTimeout(inc.timer);
		closeCall(inc);
		this.unlock(inc);
		this.leaveFullscreen();
		this.remote.srcObject = null;
		this.render();
	}

	dropIncoming() {
		if (!this.in) return;
		this.endIncoming();
		this.in = null;
		this.render();
	}

	/** The viewer closes the stream: the sender stops too. */
	closeIncoming() {
		if (this.in && this.in.state !== 'ended') this.session.send(CH.STREAM, { type: 'close', id: this.in.id });
		this.dropIncoming();
	}

	async play() {
		const video = this.remote;
		video.muted = !this.soundOn;
		try {
			await video.play();
		} catch {
			// Sound needs a recent tap on the page; fall back to muted with "Tap for sound".
			if (!video.muted) {
				video.muted = true;
				this.soundOn = false;
				await video.play().catch(() => {});
			}
		}
		this.render();
	}

	setSound(on) {
		this.soundOn = on;
		this.remote.muted = !on;
		if (on) this.remote.play().catch(() => {});
		this.render();
	}

	async toggleFullscreen() {
		if (document.fullscreenElement) {
			document.exitFullscreen().catch(() => {});
			return;
		}
		try {
			await this.stage.requestFullscreen({ navigationUI: 'hide' });
			const { videoWidth, videoHeight } = this.remote;
			if (coarse() && videoWidth > videoHeight) await screen.orientation?.lock?.('landscape')?.catch(() => {});
		} catch (err) {
			console.warn('[peerkit] fullscreen failed', err);
		}
	}

	togglePip() {
		if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
		else this.remote.requestPictureInPicture().catch(() => toast('Picture-in-picture is not available'));
	}

	leaveFullscreen() {
		if (document.fullscreenElement === this.stage) document.exitFullscreen().catch(() => {});
		if (document.pictureInPictureElement === this.remote) document.exitPictureInPicture().catch(() => {});
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

	render() {
		const { out, in: inc, connected } = this;
		const playing = inc?.state === 'playing' && Boolean(inc.stream);
		const hasAudio = playing && inc.stream.getAudioTracks().length > 0;
		const facing = out?.stream.getVideoTracks()[0]?.getSettings().facingMode;

		this.el.classList.toggle('has-remote', Boolean(inc));
		this.el.classList.toggle('has-preview', Boolean(out));
		this.remote.hidden = !playing;
		this.preview.hidden = !out;
		// Mirror yourself, as in a mirror, except the back camera.
		this.preview.classList.toggle('mirror', out?.kind === 'camera' && facing !== 'environment');
		this.preview.classList.toggle('paused', Boolean(out?.paused));
		this.soundBtn.hidden = !(hasAudio && this.remote.muted);

		this.stageActions.hidden = !playing;
		if (playing) {
			const fullscreen = Boolean(document.fullscreenElement);
			this.stageActions.replaceChildren(...[
				hasAudio && !this.remote.muted && iconButton('volume', 'Mute', () => this.setSound(false)),
				document.pictureInPictureEnabled && iconButton('pip', 'Picture-in-picture', () => this.togglePip()),
				this.stage.requestFullscreen && iconButton(fullscreen ? 'minimize' : 'maximize', fullscreen ? 'Exit full screen' : 'Full screen', () => this.toggleFullscreen()),
				iconButton('close', 'Close stream', () => this.closeIncoming()),
			].filter(Boolean));
		}

		this.renderMessage(inc, out);
		this.renderResume(connected, out);
		this.renderBar(connected, out);
	}

	renderMessage(inc, out) {
		let content = null;
		if (inc?.state === 'connecting') {
			content = [h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('p', {}, `Connecting to the ${KIND_NOUN[inc.kind]}…`)];
		} else if (inc?.state === 'paused') {
			content = [h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('p', {}, 'Paused until the connection comes back…')];
		} else if (inc?.state === 'ended') {
			content = [h('p', {}, inc.kind === 'screen' ? 'Screen sharing ended' : 'Camera stream ended'), button('Close', null, () => this.dropIncoming(), 'btn')];
		} else if (!inc && !out) {
			content = [
				icon('camera'),
				h('p', {}, 'Share your camera or screen with the other device.'),
				h('p', { class: 'hint' }, 'When the other device shares, its video appears here.'),
			];
		}
		this.message.hidden = !content;
		if (content) this.message.replaceChildren(...content);
	}

	renderResume(connected, out) {
		const kind = this.resume;
		const show = Boolean(kind) && connected && !out;
		this.resumeBar.hidden = !show;
		if (!show) return;
		this.resumeBar.replaceChildren(
			h('span', {}, `Your ${kind === 'screen' ? 'screen sharing' : 'camera'} stopped when the page reloaded or the connection dropped.`),
			button('Resume', null, () => (kind === 'screen' ? this.startScreen() : this.startCamera()), 'btn small primary'),
			iconButton('close', 'Dismiss', () => {
				this.resume = null;
				writeResume(null);
				this.render();
			}));
	}

	renderBar(connected, out) {
		if (!out) {
			const disabled = !connected || this.busy || !canCapture();
			this.bar.replaceChildren(...[
				button('Share camera', 'camera', () => this.startCamera(), 'btn'),
				canShareScreen() && button('Share screen', 'monitor', () => this.startScreen(), 'btn'),
				!canCapture() && h('span', { class: 'hint' }, 'Sharing needs HTTPS.'),
			].filter(Boolean));
			for (const control of this.bar.querySelectorAll('button')) control.disabled = disabled;
			return;
		}

		const audio = out.stream.getAudioTracks();
		const micOn = Boolean(audio[0]?.enabled);
		const label = out.paused ? 'Paused, reconnecting…' : out.kind === 'screen' ? 'You are sharing your screen' : 'Sharing camera';
		const items = [h('span', { class: 'live', 'data-paused': out.paused }, label)];
		if (out.kind === 'camera') {
			if (this.cameraCount > 1) items.push(iconButton('switch-camera', 'Switch camera', () => this.switchCamera()));
			items.push(iconButton(micOn ? 'mic' : 'mic-off', !audio.length ? 'No microphone' : micOn ? 'Mute microphone' : 'Unmute microphone', () => this.toggleMic(), {
				disabled: !audio.length,
				pressed: audio.length ? !micOn : null,
			}));
			items.push(h('select', { class: 'input select', 'aria-label': 'Resolution', onchange: e => this.setResolution(e.target.value) },
				Object.keys(RESOLUTIONS).map(res => h('option', { value: res, selected: res === this.prefs.res }, res))));
		}
		items.push(button('Stop', 'stop', () => this.stopOutgoing(), 'btn small danger'));
		this.bar.replaceChildren(...items);
		if (this.busy) for (const control of this.bar.querySelectorAll('button, select')) control.disabled = true;
	}
}
