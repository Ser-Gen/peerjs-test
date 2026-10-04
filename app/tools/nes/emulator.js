import { Emitter } from '../../emitter.js';

/*
 * FCEUX 2.2.3 compiled with Emscripten (vendor/fceux/, from hauxir/fceux: see vendor/README.md), run in a same-origin
 * iframe: the build lives in globals (Module, FS, SDL) and can only be unloaded with its page. What it offers:
 *   Module.arguments ['--no-config', '1', '/romfile'], the ROM written to the FS between run dependencies
 *   _setGamePadValue(pad 0–3, button, on)   buttons in NES_BUTTONS' order, added to the emulator's own keys
 *   _enableFourScore()                     pads 3 and 4
 *   _saveState() / _loadState()            through /DUMP.frz in its FS ("FCSX" files; a broken one is ignored)
 *   window.SDL.destination                 where its sound goes (a node of SDL.audioContext)
 * It has no reset: Reset boots the ROM again.
 *
 * Its main loop runs one NES frame per requestAnimationFrame, so a 120 Hz screen would run games twice as fast.
 * The iframe's requestAnimationFrame is replaced: frames are run from this page's own, as many as are due at the
 * NES rate (Pacer).
 */

export const NES_FPS = 39375000 / 655171; // 60.0988 frames a second (NTSC)
export const NES_BUTTONS = ['A', 'B', 'Select', 'Start', 'Up', 'Down', 'Left', 'Right'];
export const PADS = 4;
export const MAX_ROM = 4 * 1024 * 1024;
export const MAX_STATE = 1024 * 1024;
const STATE_FILE = '/DUMP.frz';

/** Where the emulator's files are and how they load; tests replace these. */
export const nesFiles = {
	frame: new URL('./frame.html', import.meta.url).href, // null: an empty iframe
	script: new URL('../../../vendor/fceux/fceux.js', import.meta.url).href,
	wasm: new URL('../../../vendor/fceux/fceux.wasm', import.meta.url).href,
	async bytes(url) {
		const response = await fetch(url);
		if (!response.ok) throw new Error(`${response.status}`);
		return new Uint8Array(await response.arrayBuffer());
	},
	run(win, url) {
		return new Promise((resolve, reject) => {
			const script = win.document.createElement('script');
			script.src = url;
			script.onload = resolve;
			script.onerror = () => reject(new Error('script'));
			win.document.head.append(script);
		});
	},
};

let wasmBytes = null;
const loadWasm = () => {
	wasmBytes ??= nesFiles.bytes(nesFiles.wasm).catch(err => {
		wasmBytes = null;
		throw err;
	});
	return wasmBytes;
};

/** 'ines', 'unif' or null: what FCEUX can be given. */
export function romKind(bytes) {
	if (!(bytes instanceof Uint8Array) || bytes.length < 16 || bytes.length > MAX_ROM) return null;
	const magic = String.fromCharCode(...bytes.subarray(0, 4));
	if (magic === 'NES\x1a') return 'ines';
	if (magic === 'UNIF') return 'unif';
	return null;
}

/** A save state FCEUX wrote: "FCSX" and a sane size. */
export const isState = bytes => bytes instanceof Uint8Array && bytes.length >= 16 && bytes.length <= MAX_STATE
	&& String.fromCharCode(...bytes.subarray(0, 4)) === 'FCSX';

/** How many emulator frames are due at a display frame, so games run at the NES rate on any screen. */
export class Pacer {
	constructor(fps = NES_FPS) {
		this.step = 1000 / fps;
		this.reset();
	}

	reset() {
		this.last = null;
		this.acc = 0;
	}

	due(now) {
		if (this.last == null) {
			this.last = now;
			return 1;
		}
		let dt = now - this.last;
		this.last = now;
		if (dt < 0 || dt > 250) dt = this.step; // after a stall (a hidden page) go on, don't catch up
		this.acc += dt;
		let n = Math.floor(this.acc / this.step);
		this.acc -= n * this.step;
		if (n > 2) {
			n = 2; // a slow frame: drop the rest rather than run fast after it
			this.acc = 0;
		}
		return n;
	}
}

/**
 * One running game. `boot(rom)` loads the emulator in an iframe inside `container` and starts it; `beforeFrame`
 * is called before every emulated frame (the place to set the pads). Events: 'pause', 'sound' (the audio context
 * was blocked or unblocked).
 */
export class Emulator extends Emitter {
	constructor(container) {
		super();
		this.container = container;
		this.pacer = new Pacer();
		this.queue = []; // the emulator's requestAnimationFrame callbacks
		this.frames = 0;
		this.paused = false;
		this.muted = false;
		this.pads = new Uint8Array(PADS); // what each pad has now, NES_BUTTONS as bits
		this.beforeFrame = null;
		this.raf = 0;
		this.win = null;
		this.module = null;
		this.audio = null;
		this.stream = null;
		this.destroyed = false;
		this.tick = now => {
			this.raf = requestAnimationFrame(this.tick);
			if (this.paused) return;
			const n = this.pacer.due(now);
			for (let i = 0; i < n; i++) this.step(now);
		};
		this.onVisibility = () => this.applySound();
	}

	async boot(rom) {
		const iframe = (this.iframe = document.createElement('iframe'));
		iframe.className = 'nes-frame';
		iframe.title = 'NES';
		iframe.tabIndex = -1;
		iframe.setAttribute('allow', 'autoplay');
		this.container.append(iframe);
		const win = await new Promise((resolve, reject) => {
			if (!nesFiles.frame) return resolve(iframe.contentWindow);
			iframe.addEventListener('load', () => resolve(iframe.contentWindow), { once: true });
			iframe.addEventListener('error', () => reject(new Error('frame')), { once: true });
			iframe.src = nesFiles.frame;
		});
		const wasm = await loadWasm();
		if (this.destroyed) throw new Error('stopped');
		this.win = win;
		const doc = win.document;
		let canvas = doc.getElementById('canvas');
		if (!canvas) {
			canvas = doc.createElement('canvas');
			canvas.id = 'canvas';
			doc.body.append(canvas);
		}
		canvas.width = 256;
		canvas.height = 224;
		this.canvas = canvas;
		win.requestAnimationFrame = fn => {
			this.queue.push(fn);
			return this.queue.length;
		};
		win.cancelAnimationFrame = () => {};
		await new Promise((resolve, reject) => {
			win.neswasm = 'fceux.wasm';
			win.Module = {
				wasmBinary: wasm,
				arguments: ['--no-config', '1', '/romfile'],
				preRun: [() => win.addRunDependency('rom')],
				postRun: [() => resolve()],
				print: () => {},
				printErr: () => {},
				onAbort: what => reject(new Error(String(what))),
				canvas,
				doNotCaptureKeyboard: true, // keys are this page's (the tool maps them), never the emulator's own
				setStatus: () => {},
				monitorRunDependencies: () => {},
			};
			nesFiles.run(win, nesFiles.script).then(() => {
				win.FS.createDataFile('/', 'romfile', rom, true, true);
				win.removeRunDependency('rom');
			}, reject);
		});
		if (this.destroyed) throw new Error('stopped');
		// A file FCEUX can't run ends main() without starting the loop.
		if (!win.Browser?.mainLoop?.func) throw new Error('not a game');
		this.module = win.Module;
		this.module._enableFourScore();
		this.connectAudio();
		document.addEventListener('visibilitychange', this.onVisibility);
		this.raf = requestAnimationFrame(this.tick);
	}

	/** Sound: the emulator → out → (volume → speakers) and (a stream for Remote play). */
	connectAudio() {
		const SDL = this.win.SDL;
		const ctx = SDL?.audioContext;
		if (!ctx) return;
		const out = ctx.createGain();
		const volume = ctx.createGain();
		out.connect(volume);
		volume.connect(ctx.destination);
		let tap = null;
		try {
			tap = ctx.createMediaStreamDestination();
			out.connect(tap);
		} catch {
			// no streams here: Remote play gets the picture only
		}
		SDL.destination = out;
		this.audio = { ctx, volume, tap };
		ctx.onstatechange = () => this.emit('sound');
		this.applySound();
	}

	/** The browser didn't let the sound start (no tap on this page yet). */
	get soundBlocked() {
		return Boolean(this.audio && this.audio.ctx.state === 'suspended' && !this.paused && !document.hidden);
	}

	/** Call from a tap or a key: starts sound the browser held back. */
	unblockSound() {
		if (this.audio && !this.paused) this.audio.ctx.resume?.().catch(() => {});
	}

	applySound() {
		if (!this.audio) return;
		this.audio.volume.gain.value = this.muted ? 0 : 1;
		const run = !this.paused && !document.hidden;
		const ctx = this.audio.ctx;
		if (run && ctx.state === 'suspended') ctx.resume?.().catch(() => {});
		else if (!run && ctx.state === 'running') ctx.suspend?.().catch(() => {});
	}

	setMuted(muted) {
		this.muted = muted;
		this.applySound();
	}

	setPaused(paused) {
		if (this.paused === paused) return;
		this.paused = paused;
		this.pacer.reset();
		this.applySound();
		this.emit('pause', paused);
	}

	/** One emulated frame. */
	step(now = performance.now()) {
		if (!this.module) return;
		this.beforeFrame?.();
		const due = this.queue;
		this.queue = [];
		for (const fn of due) fn(now);
		this.frames++;
	}

	/** A pad's buttons, NES_BUTTONS as bits; only changes reach the emulator. */
	setPad(pad, bits) {
		if (!this.module || pad < 0 || pad >= PADS) return;
		const was = this.pads[pad];
		if (was === bits) return;
		this.pads[pad] = bits;
		for (let i = 0; i < NES_BUTTONS.length; i++) {
			const on = (bits >> i) & 1;
			if (((was >> i) & 1) !== on) this.module._setGamePadValue(pad, i, on);
		}
	}

	saveState() {
		if (!this.module) return null;
		this.module._saveState();
		try {
			return new Uint8Array(this.win.FS.readFile(STATE_FILE));
		} catch {
			return null;
		}
	}

	loadState(bytes) {
		if (!this.module || !isState(bytes)) return false;
		this.win.FS.writeFile(STATE_FILE, bytes);
		this.module._loadState();
		return true;
	}

	/** The picture and sound as a MediaStream, for Remote play (made once). */
	captureStream() {
		if (this.stream) return this.stream;
		const video = this.canvas?.captureStream?.(60);
		if (!video) return null;
		this.stream = new MediaStream([...video.getVideoTracks(), ...(this.audio?.tap?.stream.getAudioTracks() ?? [])]);
		return this.stream;
	}

	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		cancelAnimationFrame(this.raf);
		document.removeEventListener('visibilitychange', this.onVisibility);
		this.stream?.getTracks().forEach(track => track.stop());
		if (this.audio) {
			this.audio.ctx.onstatechange = null;
			this.audio.ctx.close?.().catch(() => {});
		}
		this.module = null;
		this.queue = [];
		this.iframe?.remove(); // the emulator goes with its page
	}
}
