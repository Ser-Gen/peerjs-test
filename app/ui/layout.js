import { h, icon, loadStylesheet } from './dom.js';
import { readJSON, writeJSON } from '../util.js';

const LAYOUT_KEY = 'peerkit.layout';
const LAYOUT_VERSION = 1;
export const WIDE = '(min-width: 900px) and (pointer: fine)';
const SIDE_WIDTH = 360; // px, the side column of the default layout
const SAVE_DELAY = 300; // a resize drag changes the layout many times a second
const THEME = { name: 'peerkit', className: 'dockview-theme-peerkit' }; // its colours are in styles.css

let loading = null;

/**
 * dockview (0.5 MB with its stylesheet) is fetched only where it is used: a wide window with a mouse.
 * The service worker caches it then, as it does the editor bundle.
 */
export function loadDock() {
	loading ??= Promise.all([import('../../vendor/dockview.js'), loadStylesheet(new URL('../../vendor/dockview.css', import.meta.url).href)])
		.then(([lib]) => lib)
		.catch(err => {
			loading = null; // try again next time the window gets wide
			throw err;
		});
	return loading;
}

// Tools whose id changed since a layout may have been saved: old id → new (the NES tool became Games in 0.17).
const RENAMED = { nes: 'games' };

/** A saved layout with the old ids of renamed tools replaced (they appear as quoted strings, and a tab's text is the tool's own). */
function renamed(layout) {
	if (!layout || typeof layout !== 'object') return layout;
	let json = JSON.stringify(layout);
	for (const [from, to] of Object.entries(RENAMED)) json = json.replaceAll(`"${from}"`, `"${to}"`);
	return JSON.parse(json);
}

/**
 * The saved layout and the tools it doesn't have yet (added to the app since it was saved), or null when there is
 * none or it holds a tool this version doesn't have: then the default is used.
 */
function savedLayout(ids) {
	const saved = readJSON(LAYOUT_KEY);
	const layout = saved?.version === LAYOUT_VERSION ? renamed(saved.layout) : null;
	if (!layout || typeof layout !== 'object' || !layout.panels || typeof layout.panels !== 'object') return null;
	if (Array.isArray(layout.popoutGroups) && layout.popoutGroups.length) return null; // never made here
	// A tool's own panels (a stream, "stream:<id>") are left out: what they showed is gone after a reload.
	const panels = Object.keys(layout.panels).filter(id => !id.includes(':'));
	if (!panels.length || panels.some(id => !ids.includes(id))) return null;
	return { layout, missing: ids.filter(id => !panels.includes(id)) };
}

function setButton(button, label, name) {
	button.title = label;
	button.setAttribute('aria-label', label);
	button.replaceChildren(icon(name));
}

/**
 * Where the tools are shown: bottom tabs on phones and narrow windows, dockview panels on a wide window with a
 * mouse. Each tool has one element for its whole life; switching layouts moves it and never mounts it again,
 * so a stream keeps playing and the editor keeps its cursor.
 */
export class ToolLayout {
	/**
	 * @param {object} options
	 * @param {HTMLElement} options.host where the tools go
	 * @param {HTMLElement} options.tabs the bottom tab bar
	 * @param {{id: string, title: string}[]} options.tools
	 * @param {string[]} [options.side] the default layout puts these in a column on the right, the rest in the main area
	 * @param {string} [options.front] shown first in the main area
	 * @param {() => void} [options.onChange] after switching between tabs and panels
	 */
	constructor({ host, tabs, tools, side = [], front = null, onChange = () => {} }) {
		this.host = host;
		this.tabBar = tabs;
		this.side = side;
		this.front = front;
		this.onChange = onChange;
		this.items = new Map(tools.map(tool => [tool.id, {
			id: tool.id,
			title: tool.title,
			el: h('section', { class: 'tool', 'data-tool': tool.id }),
			tab: h('button', { type: 'button', onclick: () => this.select(tool.id) }, tool.title),
			dockTabs: new Set(),
			panel: null, // its dockview panel API while docked
			seen: false, // could be seen at the last check, while docked
			shows: new Set(),
			unread: false,
		}]));
		this.selected = tools[0]?.id ?? null;
		this.lib = null;
		this.dock = null;
		this.dockEl = null;
		this.subs = [];
		this.ready = false; // the dock is built: visibility changes from here on are the user's
		this.pending = null;
		this.dirty = false;
		this.saveTimer = null;
		this.extras = new Map(); // "<tool>:<id>" → a tool's own panel while docked (openPanel)
		this.layoutListeners = new Set();

		host.append(...[...this.items.values()].map(item => item.el));
		if (this.items.size > 1) tabs.replaceChildren(...[...this.items.values()].map(item => item.tab));
		this.select(this.selected);
		this.query = matchMedia(WIDE);
		this.query.addEventListener?.('change', () => this.fit());
		window.addEventListener('pagehide', () => this.flush());
		this.fit();
	}

	/** The element a tool mounts into. */
	element(id) {
		return this.items.get(id)?.el ?? null;
	}

	/** The bottom tabs are in use (more than one tool, no panels). */
	get tabbed() {
		return !this.dock && this.items.size > 1;
	}

	get docked() {
		return Boolean(this.dock);
	}

	// --- what tools use (ctx) ---

	/** Bring a tool to the front: its tab, or its panel within its group. */
	activate(id) {
		if (!this.dock) return this.select(id);
		const panel = this.dock.getPanel(id);
		if (!panel) return;
		if (this.dock.hasMaximizedGroup() && !panel.group.api.isMaximized()) this.dock.exitMaximizedGroup();
		panel.api.setActive();
	}

	/** Something arrived for a tool that can't be seen right now: a dot on its tab until it is shown. */
	notify(id) {
		const item = this.items.get(id);
		if (!item || this.visible(id) || item.unread) return;
		item.unread = true;
		this.renderUnread(item);
	}

	visible(id) {
		const item = this.items.get(id);
		if (!item) return false;
		// A maximized group hides the others, but dockview still calls their panels visible: ask the group too.
		return this.dock ? Boolean(item.panel?.isVisible && item.panel.group?.api.isVisible) : !item.el.hidden;
	}

	/** Called each time the tool comes into view; returns an unsubscribe function. */
	onShow(id, fn) {
		const shows = this.items.get(id)?.shows;
		shows?.add(fn);
		return () => shows?.delete(fn);
	}

	/** Called after switching between tabs and panels, and after Reset layout; returns an unsubscribe function. */
	onLayout(fn) {
		this.layoutListeners.add(fn);
		return () => this.layoutListeners.delete(fn);
	}

	changed() {
		this.onChange();
		for (const fn of [...this.layoutListeners]) fn();
	}

	/**
	 * A panel of a tool's own, next to the tool's panel (a stream): only while docked, null otherwise. Switching to
	 * tabs or Reset layout closes it without `onClose` and tells the tool through onLayout, which puts its
	 * element back where it belongs; its tab has a close button that calls `onClose`.
	 * @returns {{open: boolean, close(): void, activate(): void, setTitle(title: string): void} | null}
	 */
	openPanel(owner, { id, title, el, onClose = () => {} }) {
		if (!this.dock || !this.ready || !this.items.has(owner)) return null;
		const key = `${owner}:${id}`;
		const known = this.extras.get(key);
		if (known) return known.handle;
		const extra = { key, owner, title, el, onClose, tabs: new Set(), open: true, handle: null };
		// The first one joins the tool's group, the next ones go to the right of the last, so two streams show side by side.
		const last = [...this.extras.values()].filter(other => other.owner === owner).at(-1);
		const reference = last ? { referencePanel: last.key, direction: 'right' } : this.dock.getPanel(owner) ? { referencePanel: owner, direction: 'within' } : null;
		this.extras.set(key, extra);
		extra.handle = {
			get open() {
				return extra.open;
			},
			close: () => this.closeExtra(extra),
			activate: () => extra.open && this.dock?.getPanel(key)?.api.setActive(),
			setTitle: text => {
				extra.title = text;
				for (const tab of extra.tabs) {
					tab.querySelector('.dv-default-tab-content').textContent = text;
					const close = tab.querySelector('.dock-tab-close');
					close.title = `Close ${text}`;
					close.setAttribute('aria-label', `Close ${text}`);
				}
				this.dock?.getPanel(key)?.api.setTitle(text);
			},
		};
		if (this.dock.hasMaximizedGroup()) this.dock.exitMaximizedGroup();
		this.dock.addPanel({ id: key, component: 'tool', title, ...(reference && { position: reference }) });
		return extra.handle;
	}

	closeExtra(extra) {
		if (!extra.open) return;
		extra.open = false;
		this.extras.delete(extra.key);
		const panel = this.dock?.getPanel(extra.key);
		if (panel) this.dock.removePanel(panel);
		extra.el.remove();
	}

	// --- tabs ---

	select(id) {
		if (!this.items.has(id)) return;
		this.selected = id;
		if (this.dock) return this.activate(id);
		for (const item of this.items.values()) {
			const hidden = item.id !== id;
			item.tab.setAttribute('aria-current', String(!hidden));
			if (item.el.hidden === hidden) continue;
			item.el.hidden = hidden;
			if (!hidden) this.shown(item);
		}
	}

	shown(item) {
		if (item.unread) {
			item.unread = false;
			this.renderUnread(item);
		}
		for (const fn of [...item.shows]) fn();
	}

	/** While docked: tell the tools that came into view since the last check. */
	refresh() {
		if (!this.ready) return;
		for (const item of this.items.values()) {
			const seen = this.visible(item.id);
			if (seen && !item.seen) this.shown(item);
			item.seen = seen;
		}
	}

	renderUnread(item) {
		item.tab.classList.toggle('notify', item.unread);
		for (const tab of item.dockTabs) tab.classList.toggle('notify', item.unread);
	}

	// --- switching ---

	/** Follow the window: panels when it is wide and has a mouse, tabs otherwise. */
	fit() {
		if (this.query.matches) this.toDock();
		else this.toTabs();
	}

	async toDock() {
		if (this.dock || this.pending) return;
		const pending = (this.pending = loadDock().catch(err => {
			console.warn('[peerkit] the desktop layout could not load; staying with tabs', err);
			return null;
		}));
		const lib = await pending;
		if (this.pending !== pending) return; // the window got narrow meanwhile
		this.pending = null;
		if (!lib || !this.query.matches) return;
		this.moving(() => this.build(lib));
		// The tool that was in front in the tabs stays in front.
		this.dock.getPanel(this.selected)?.api.setActive();
		this.changed();
	}

	toTabs() {
		this.pending = null;
		if (!this.dock) return;
		this.flush();
		const active = this.dock.activePanel?.id;
		this.moving(() => this.teardown());
		this.select(this.items.has(active) ? active : this.selected);
		this.changed();
	}

	/** Back to the default: the main area and the side column. */
	reset() {
		if (!this.dock) return;
		this.moving(() => {
			const lib = this.lib;
			this.teardown();
			this.build(lib, { fresh: true });
		});
		this.save();
		this.changed();
	}

	/**
	 * Moving an element in the page pauses the videos in it (and would reload an iframe), so what was playing
	 * is started again afterwards.
	 */
	moving(fn) {
		const media = [...this.host.querySelectorAll('video, audio')];
		const playing = media.filter(el => !el.paused);
		fn();
		for (const el of playing) if (el.paused) el.play().catch(() => {});
	}

	build(lib, { fresh = false } = {}) {
		this.lib = lib;
		this.ready = false;
		this.dockEl = h('div', { class: 'dock' });
		this.host.classList.add('docked');
		this.host.append(this.dockEl);
		for (const item of this.items.values()) item.el.hidden = false;
		this.dock = lib.createDockview(this.dockEl, {
			theme: THEME,
			// Every tool stays in the page, as with tabs: a hidden stream keeps its sound, the chat keeps its scroll.
			defaultRenderer: 'always',
			defaultTabComponent: 'tool',
			floatingGroupBounds: 'boundedWithinViewport',
			createComponent: ({ id }) => this.panelFor(id),
			createTabComponent: ({ id }) => this.tabFor(id),
			createRightHeaderActionComponent: group => this.actionsFor(group),
		});
		if (fresh || !this.restore()) this.arrange();
		this.subs = [
			this.dock.onDidLayoutChange(() => {
				this.save();
				this.refresh();
			}),
			this.dock.onDidMaximizedGroupChange(() => this.refresh()),
		];
		for (const item of this.items.values()) item.seen = false;
		this.ready = true;
		this.refresh();
	}

	teardown() {
		// Out of the dock first: disposing it removes its panels' elements. A tool's own panels just close; the
		// tool puts their elements back when it hears of the change.
		for (const item of this.items.values()) this.host.append(item.el);
		for (const extra of this.extras.values()) {
			extra.open = false;
			extra.el.remove();
		}
		this.extras.clear();
		for (const sub of this.subs) sub.dispose();
		this.subs = [];
		this.ready = false;
		this.dock.dispose();
		this.dockEl.remove();
		this.host.classList.remove('docked');
		this.dock = this.dockEl = null;
		for (const item of this.items.values()) {
			item.panel = null;
			item.dockTabs.clear();
		}
	}

	restore() {
		const saved = savedLayout([...this.items.keys()]);
		if (!saved) return false;
		try {
			this.dock.fromJSON(saved.layout);
			for (const panel of this.dock.panels.filter(panel => !this.items.has(panel.id))) this.dock.removePanel(panel);
			for (const id of saved.missing) this.addNew(id);
			if (saved.missing.length) this.save();
			return true;
		} catch (err) {
			console.warn('[peerkit] the saved layout could not be restored', err);
			writeJSON(LAYOUT_KEY, null); // so the next start doesn't trip over it again
			try {
				this.dock.clear();
			} catch {
				// what fromJSON left is replaced by the default below
			}
			return false;
		}
	}

	/** A tool the saved layout didn't know yet: a tab in the main area, behind the one in front there. */
	addNew(id) {
		const panels = this.dock.panels.map(panel => panel.id);
		const main = panels.filter(other => !this.side.includes(other));
		const reference = main.includes(this.front) ? this.front : main[0] ?? panels[0];
		this.dock.addPanel({
			id,
			component: 'tool',
			title: this.items.get(id).title,
			...(reference && { position: { referencePanel: reference, direction: 'within' } }),
			inactive: true,
		});
	}

	/** The default: the side tools in a column on the right, the others as tabs in the main area. */
	arrange() {
		const ids = [...this.items.keys()];
		const side = ids.filter(id => this.side.includes(id));
		const main = ids.filter(id => !side.includes(id));
		const add = (id, position, extra = {}) => this.dock.addPanel({ id, component: 'tool', title: this.items.get(id).title, ...(position && { position }), ...extra });
		main.forEach((id, i) => add(id, i ? { referencePanel: main[0], direction: 'within' } : null));
		side.forEach((id, i) => {
			if (i) add(id, { referencePanel: side[0], direction: 'within' });
			else add(id, main.length ? { referencePanel: main[0], direction: 'right' } : null, { initialWidth: SIDE_WIDTH });
		});
		const front = main.includes(this.front) ? this.front : main[0];
		if (front) this.dock.getPanel(front)?.api.setActive();
	}

	// --- dockview parts ---

	panelFor(id) {
		const item = this.items.get(id);
		const element = h('div', { class: 'dock-panel' });
		const extra = this.extras.get(id);
		if (extra) {
			element.append(extra.el);
			let sub = null;
			return {
				element,
				init: params => (sub = params.api.onDidVisibilityChange(() => this.refresh())),
				dispose: () => sub?.dispose(),
			};
		}
		if (!item) return { element, init() {} };
		element.append(item.el);
		let api = null;
		let sub = null;
		return {
			element,
			init: params => {
				api = item.panel = params.api;
				sub = api.onDidVisibilityChange(() => this.refresh());
			},
			dispose: () => {
				sub?.dispose();
				if (item.panel === api) item.panel = null;
			},
		};
	}

	/** A tab with the tool's name and the unread dot; there is no close button, since a tool can't be closed. */
	tabFor(id) {
		const extra = this.extras.get(id);
		if (extra) return this.extraTab(extra);
		const item = this.items.get(id);
		const element = h('div', { class: 'dv-default-tab dock-tab' }, h('span', { class: 'dv-default-tab-content' }, item?.title ?? id));
		if (item) {
			item.dockTabs.add(element);
			element.classList.toggle('notify', item.unread);
		}
		return {
			element,
			init() {},
			dispose: () => item?.dockTabs.delete(element),
		};
	}

	/** A tool's own panel can be closed: its tab has a close button, which asks the tool (a viewer closing a stream). */
	extraTab(extra) {
		const close = h('button', {
			type: 'button',
			class: 'icon-btn small dock-tab-close',
			title: `Close ${extra.title}`,
			'aria-label': `Close ${extra.title}`,
			// dockview starts a drag or makes the tab active on pointerdown; this button only closes.
			onpointerdown: event => event.stopPropagation(),
			onclick: event => {
				event.stopPropagation();
				extra.onClose();
			},
		}, icon('close'));
		const element = h('div', { class: 'dv-default-tab dock-tab' }, h('span', { class: 'dv-default-tab-content' }, extra.title), close);
		extra.tabs.add(element);
		return {
			element,
			init() {},
			dispose: () => extra.tabs.delete(element),
		};
	}

	/** Float / put back and maximize / restore, at the right of each group's tabs. */
	actionsFor(group) {
		const float = h('button', { type: 'button', class: 'icon-btn small' });
		const max = h('button', { type: 'button', class: 'icon-btn small' });
		const element = h('div', { class: 'dock-actions' }, float, max);
		const floating = () => group.api.location.type === 'floating';
		const render = () => {
			setButton(float, floating() ? 'Put back into the layout' : 'Float (or drag a tab with Shift held)', 'pip');
			max.hidden = floating();
			const maximized = !floating() && group.api.isMaximized();
			setButton(max, maximized ? 'Restore' : 'Maximize', maximized ? 'minimize' : 'maximize');
		};
		float.addEventListener('click', () => {
			if (floating()) group.api.moveTo({ position: 'right' });
			else this.dock.addFloatingGroup(group);
		});
		max.addEventListener('click', () => (group.api.isMaximized() ? group.api.exitMaximized() : group.api.maximize()));
		let subs = [];
		return {
			element,
			init: ({ api, containerApi }) => {
				subs = [api.onDidLocationChange(render), containerApi.onDidMaximizedGroupChange(render)];
				render();
			},
			dispose: () => subs.forEach(sub => sub.dispose()),
		};
	}

	// --- saving ---

	save() {
		this.dirty = true;
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY);
	}

	flush() {
		clearTimeout(this.saveTimer);
		this.saveTimer = null;
		if (!this.dirty || !this.dock) return;
		this.dirty = false;
		writeJSON(LAYOUT_KEY, { version: LAYOUT_VERSION, layout: this.dock.toJSON() });
	}
}
