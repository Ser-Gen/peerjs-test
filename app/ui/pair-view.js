import { joinLink, parseLink, parseRoomCode, recentHosts } from '../rooms.js';
import { isPublic, profiles, serverKey } from '../settings.js';
import { copyText, readJSON, timeAgo, writeJSON } from '../util.js';
import { button, h, icon, toast } from './dom.js';
import { renderQR } from './qr.js';

const TAB_KEY = 'peerkit.pairTab';

/** Start screen of a host page: "Show code" (room code, QR, link) and "Join" (type a code, recent hosts). */
export class PairView {
	constructor(el, { onJoin, onChangeServer, onNewCode, onBack }) {
		this.onJoin = onJoin;
		this.onChangeServer = onChangeServer;
		this.onNewCode = onNewCode;
		this.url = null;
		this.own = null; // { code, server } of this host, to catch joining yourself

		const tab = (name, label) => h('button', { type: 'button', role: 'tab', class: 'segment', onclick: () => this.select(name, true) }, label);
		this.tabs = { host: tab('host', 'Show code'), join: tab('join', 'Join') };

		this.code = h('p', { class: 'room-code' });
		this.qr = h('div', { class: 'qr', role: 'img', 'aria-label': 'QR code with the session link' });
		this.status = h('div', { class: 'pair-status', role: 'status' });
		this.link = h('input', { class: 'link', type: 'text', readonly: true, 'aria-label': 'Session link', onfocus: () => this.link.select() });
		this.ready = h('div', { class: 'pair-ready' },
			h('p', { class: 'hint' }, 'Scan the QR code with the other device’s camera, send it the link, or enter the code in PeerKit → Join.'),
			this.link,
			h('div', { class: 'actions' },
				button('Copy link', 'copy', () => this.copy(), 'btn primary'),
				navigator.share && button('Share…', 'share', () => this.share(), 'btn')));
		this.hostServer = h('p', { class: 'server-line' });
		this.hostPanel = h('div', { class: 'pair-panel host', role: 'tabpanel' }, this.code, this.qr, this.status, this.ready, this.hostServer);

		this.input = h('input', {
			class: 'input room-input',
			type: 'text',
			placeholder: 'fox-42',
			autocomplete: 'off',
			autocapitalize: 'none',
			autocorrect: 'off',
			spellcheck: 'false',
			enterkeyhint: 'go',
			oninput: () => this.showJoinError(''),
		});
		this.joinError = h('p', { class: 'form-error', role: 'alert', hidden: true });
		this.joinServer = h('p', { class: 'server-line' });
		this.recent = h('div', { class: 'recent' });
		this.joinPanel = h('div', { class: 'pair-panel join', role: 'tabpanel' },
			h('form', { class: 'join-form', novalidate: true, onsubmit: e => { e.preventDefault(); this.submit(); } },
				h('label', { class: 'field' },
					h('span', {}, 'Room code shown on the host'),
					h('span', { class: 'join-row' }, this.input, h('button', { type: 'submit', class: 'btn primary' }, 'Join'))),
				this.joinError),
			this.joinServer,
			h('p', { class: 'hint' }, 'A code works only when both devices use the same server. A link or QR code carries the server with it.'),
			this.recent);

		this.back = button('Back to session', null, onBack, 'btn ghost');
		el.replaceChildren(
			h('div', { class: 'segmented', role: 'tablist', 'aria-label': 'Pairing' }, this.tabs.host, this.tabs.join),
			this.hostPanel,
			this.joinPanel,
			this.back);

		profiles.on('change', () => this.renderJoin());
		recentHosts.on('change', () => this.renderJoin());
		this.select(readJSON(TAB_KEY) === 'join' ? 'join' : 'host');
	}

	/** `status` ({spinner, title, text, actions}) replaces the QR while the code isn't usable. */
	update({ code, url, profile, status, showBack }) {
		this.own = { code, server: serverKey(profile) };
		this.code.textContent = code;
		this.hostServer.replaceChildren(
			...this.serverLine(profile.name),
			' · ',
			h('button', { type: 'button', class: 'link-btn', onclick: this.onNewCode }, 'New code'));

		this.status.hidden = !status;
		if (status) {
			this.status.replaceChildren(
				status.spinner && h('div', { class: 'spinner', 'aria-hidden': 'true' }),
				h('h2', {}, status.title),
				h('p', { class: 'hint' }, status.text),
				status.actions?.length ? h('div', { class: 'actions' }, status.actions) : null);
		}
		const ready = Boolean(url) && !status;
		this.qr.hidden = this.ready.hidden = !ready;
		if (ready && url !== this.url) {
			this.url = url;
			renderQR(this.qr, url);
			this.link.value = url;
		}
		this.back.hidden = !showBack;
		this.renderJoin();
	}

	select(name, byUser = false) {
		for (const [tab, btn] of Object.entries(this.tabs)) btn.setAttribute('aria-selected', String(tab === name));
		this.hostPanel.hidden = name !== 'host';
		this.joinPanel.hidden = name !== 'join';
		if (!byUser) return;
		writeJSON(TAB_KEY, name);
		// On phones the keyboard would cover the recent hosts; there a tap on the field is enough.
		if (name === 'join' && !matchMedia('(pointer: coarse)').matches) this.input.focus();
	}

	renderJoin() {
		const active = profiles.active;
		this.joinServer.replaceChildren(...this.serverLine(active.name));
		const hosts = recentHosts.list();
		this.recent.hidden = !hosts.length;
		this.recent.replaceChildren(
			h('h2', {}, 'Recent hosts'),
			h('ul', { class: 'recent-list' }, hosts.map(entry => h('li', { class: 'recent-item' },
				h('button', { type: 'button', class: 'recent-main', onclick: () => this.onJoin(joinLink(entry)) },
					h('span', { class: 'recent-name' }, entry.name),
					h('span', { class: 'recent-meta' },
						[entry.code, !isPublic(entry.profile) && entry.profile.name, timeAgo(entry.lastSeen)].filter(Boolean).join(' · '))),
				h('button', {
					type: 'button',
					class: 'icon-btn small',
					title: 'Remove',
					'aria-label': `Remove ${entry.name}`,
					onclick: () => recentHosts.remove(entry.key),
				}, icon('close'))))));
	}

	serverLine(name) {
		return ['Server: ', h('strong', {}, name), ' · ', h('button', { type: 'button', class: 'link-btn', onclick: this.onChangeServer }, 'Change')];
	}

	submit() {
		const value = this.input.value.trim();
		if (!value) return this.showJoinError('Enter the code shown on the host, e.g. fox-42.');
		if (value.includes('#')) {
			// A pasted PeerKit link: keep its code, token and server, but open it on this site.
			const hash = value.slice(value.indexOf('#'));
			const link = parseLink(hash);
			if (!link.isJoin || link.error) return this.showJoinError('This is not a valid PeerKit link.');
			return this.onJoin(`${location.origin}${location.pathname}${hash}`);
		}
		const code = parseRoomCode(value);
		if (!code) return this.showJoinError(`“${value.slice(0, 30)}” is not a room code. Codes look like fox-42.`);
		const profile = profiles.active;
		if (code === this.own?.code && serverKey(profile) === this.own.server) {
			return this.showJoinError('That is this device’s own code. Enter it on the other device.');
		}
		const recent = recentHosts.find(profile, code);
		this.onJoin(joinLink({ code, token: recent?.token, turn: recent?.turn, profile }));
	}

	showJoinError(message) {
		this.joinError.textContent = message;
		this.joinError.hidden = !message;
	}

	async copy() {
		toast((await copyText(this.url)) ? 'Link copied' : 'Copy failed');
	}

	share() {
		navigator.share({ title: 'PeerKit', text: 'Join my PeerKit session', url: this.url }).catch(() => {});
	}
}
