import { Emitter } from '../../emitter.js';
import { readJSON, writeJSON } from '../../util.js';

const PREFS_KEY = 'peerkit.editor';
const PREFS_VERSION = 1;
const MAX_LAST = 20; // rooms whose last open document is remembered

export const FONT_SIZES = { small: 13, medium: 15, large: 18 };

/** Which editor shows the documents on this device. Automatic: Monaco with a mouse, CodeMirror on a touch screen. */
export const ENGINES = {
	auto: 'Automatic',
	monaco: 'Monaco (as in VS Code)',
	codemirror: 'CodeMirror (made for phones too)',
};

/**
 * The Editor's settings on this device, in `peerkit.editor`: text size, wrapping, the editor, and the last open
 * document per room. The Editor and the Settings screen both change them, so both go through this one store.
 */
class EditorPrefs extends Emitter {
	constructor() {
		super();
		const raw = readJSON(PREFS_KEY);
		const ok = raw?.version === PREFS_VERSION;
		this.wrap = ok ? raw.wrap !== false : true;
		this.font = ok && Object.hasOwn(FONT_SIZES, raw.font) ? raw.font : 'medium';
		this.engine = ok && Object.hasOwn(ENGINES, raw.engine) ? raw.engine : 'auto';
		this.last = ok && raw.last && typeof raw.last === 'object' && !Array.isArray(raw.last) ? raw.last : {};
	}

	/** 'monaco' or 'codemirror'. */
	get resolved() {
		if (this.engine !== 'auto') return this.engine;
		return matchMedia('(pointer: fine)').matches ? 'monaco' : 'codemirror';
	}

	set(patch) {
		Object.assign(this, patch);
		writeJSON(PREFS_KEY, { version: PREFS_VERSION, wrap: this.wrap, font: this.font, engine: this.engine, last: this.last });
		this.emit('change', patch);
	}

	setEngine(engine) {
		if (Object.hasOwn(ENGINES, engine) && engine !== this.engine) this.set({ engine });
	}

	rememberLast(room, id) {
		if (this.last[room] === id) return;
		const last = { ...this.last };
		delete last[room]; // re-insert, so the oldest rooms are first to go
		last[room] = id;
		const rooms = Object.keys(last);
		for (const old of rooms.slice(0, Math.max(0, rooms.length - MAX_LAST))) delete last[old];
		this.set({ last });
	}
}

export const editorPrefs = new EditorPrefs();
