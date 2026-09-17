import { parseLink, parseRoomCode, roomStore } from '../rooms.js';
import { isPublic, profiles } from '../settings.js';
import { timeAgo } from '../util.js';
import { button, h, icon } from './dom.js';

/** Start screen when no room is open: New room, join by code or link, recent rooms. */
export class StartView {
	constructor(el, { onCreate, onJoin, onJoinLink, onOpen, onForget, onChangeServer }) {
		this.onJoin = onJoin;
		this.onJoinLink = onJoinLink;
		this.onChangeServer = onChangeServer;

		this.legacy = h('p', { class: 'start-notice', role: 'note', hidden: true },
			'PeerKit now works with rooms. Earlier pairings and the documents written in them are not carried over.');
		this.createServer = h('p', { class: 'server-line' });
		this.input = h('input', {
			class: 'input room-input',
			type: 'text',
			placeholder: 'amber-otter-quiet-lamp',
			autocomplete: 'off',
			autocapitalize: 'none',
			autocorrect: 'off',
			spellcheck: 'false',
			enterkeyhint: 'go',
			'aria-label': 'Room code or link',
			oninput: () => this.showError(''),
		});
		this.error = h('p', { class: 'form-error', role: 'alert', hidden: true });
		this.joinServer = h('p', { class: 'server-line' });
		this.recent = h('div', { class: 'recent' });
		this.onOpen = onOpen;
		this.onForget = onForget;

		el.replaceChildren(
			this.legacy,
			h('section', { class: 'start-section' },
				h('h1', {}, 'Rooms'),
				h('p', { class: 'hint' }, 'A room connects up to 8 devices: chat and files, the editor and streams. It keeps working when anyone leaves.'),
				button('New room', 'plus', onCreate, 'btn primary large'),
				this.createServer),
			h('section', { class: 'start-section' },
				h('h2', {}, 'Join a room'),
				h('form', { class: 'join-form', novalidate: true, onsubmit: e => { e.preventDefault(); this.submit(); } },
					h('span', { class: 'join-row' }, this.input, h('button', { type: 'submit', class: 'btn primary' }, 'Join')),
					this.error),
				h('p', { class: 'hint' }, 'Type the 4-word code, or paste a room link. The first 4 letters of each word are enough.'),
				this.joinServer),
			this.recent);

		profiles.on('change', () => this.render());
		roomStore.on('change', () => this.render());
		this.render();
	}

	render() {
		this.legacy.hidden = !roomStore.hasLegacyData;
		const active = profiles.active;
		this.createServer.replaceChildren(...this.serverLine('New rooms use the server ', active.name));
		this.joinServer.replaceChildren(...this.serverLine('A typed code works only on the same server: ', active.name));
		const rooms = roomStore.list();
		this.recent.hidden = !rooms.length;
		this.recent.replaceChildren(
			h('h2', {}, 'Recent rooms'),
			h('ul', { class: 'recent-list' }, rooms.map(entry => h('li', { class: 'recent-item' },
				h('button', { type: 'button', class: 'recent-main', onclick: () => this.onOpen(entry) },
					h('span', { class: 'recent-name' }, entry.names.length ? entry.names.join(', ') : 'Nobody else yet'),
					h('span', { class: 'recent-meta' },
						[entry.code, !isPublic(entry.profile) && entry.profile.name, entry.lastSeen && timeAgo(entry.lastSeen)].filter(Boolean).join(' · '))),
				h('button', {
					type: 'button',
					class: 'icon-btn small',
					title: 'Forget',
					'aria-label': `Forget room ${entry.code}`,
					onclick: () => this.onForget(entry),
				}, icon('trash'))))));
	}

	serverLine(text, name) {
		return [text, h('strong', {}, name), ' · ', h('button', { type: 'button', class: 'link-btn', onclick: this.onChangeServer }, 'Change')];
	}

	submit() {
		const value = this.input.value.trim();
		if (!value) return this.showError('Enter the room’s 4-word code.');
		if (value.includes('#')) {
			// A pasted PeerKit link: keep its code and server, but open it on this site.
			const hash = value.slice(value.indexOf('#'));
			const link = parseLink(hash);
			if (link.kind === 'legacy') return this.showError('This is a pairing link from an older PeerKit version. Ask for a room link.');
			if (link.kind !== 'room' || link.error) return this.showError('This is not a valid PeerKit room link.');
			return this.onJoinLink(hash);
		}
		const code = parseRoomCode(value);
		if (!code) return this.showError(`“${value.slice(0, 40)}” is not a room code. A code is 4 words, like amber-otter-quiet-lamp.`);
		this.onJoin(code);
	}

	showError(message) {
		this.error.textContent = message;
		this.error.hidden = !message;
	}
}
