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

/**
 * The saved layout and the tools it doesn't have yet (added to the app since it was saved), or null when there is
 * none or it holds a tool this version doesn't have: then the default is used.
 */
function savedLayout(ids) {
	const saved = readJSON(LAYOUT_KEY);
	const layout = saved?.version === LAYOUT_VERSION ? saved.layout : null;
	if (!layout || typeof layout !== 'object' || !layout.panels || typeof layout.panels !== 'object') return null;
	if (Array.isArray(layout.popoutGroups) && layout.popoutGroups.length) return null; // never made here
	const panels = Object.keys(layout.panels);
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
		this.onChange();
	}

	toTabs() {
		this.pending = null;
		if (!this.dock) return;
		this.flush();
		const active = this.dock.activePanel?.id;
		this.moving(() => this.teardown());
		this.select(this.items.has(active) ? active : this.selected);
		this.onChange();
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
	}

	/**
	 * Moving an element in the page pauses the videos in it (and would reload an iframe), so what was playing
	 * is started again afterwards.
	 */
	moving(fn) {
		const media = [...this.items.values()].flatMap(item => [...item.el.querySelectorAll('video, audio')]);
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
		// Out of the dock first: disposing it removes its panels' elements.
		for (const item of this.items.values()) this.host.append(item.el);
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
