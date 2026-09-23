import { MAX_MEMBERS, Room, describeError } from './room.js';
import { newRoomCode, parseLink, roomIds, roomLink, roomStore } from './rooms.js';
import { PUBLIC_PROFILE, isPublic, peerOptions, profiles, sameConnection } from './settings.js';
import { IceConfig } from './turn.js';
import { dropShare, peekShare, takeShare } from './share.js';
import { registerServiceWorker } from './pwa.js';
import { Voice } from './voice.js';
import { button, h, icon, openDialog, toast } from './ui/dom.js';
import { renderQR } from './ui/qr.js';
import { SettingsView } from './ui/settings-view.js';
import { StartView } from './ui/start-view.js';
import { claimTab, copyText } from './util.js';
import editor from './tools/editor/editor.js';
import stream from './tools/stream.js';
import transfer from './tools/transfer.js';

const TOOLS = [transfer, stream, editor].filter(tool => tool.supported());

const INVITE_KEY = 'peerkit.invite'; // sessionStorage: the new room whose invite sheet opens once it is ready
const SERVER_ERRORS = new Set(['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected', 'invalid-key', 'ssl-unavailable']);
// Links and codes that can't work however often they are retried.
const DEAD_ENDS = new Set(['bad-link', 'invalid-code', 'legacy-link', 'browser-incompatible']);
const ICE_REFRESH_EVERY = 3600 * 1000;
const SLOW_LOOKUP = 2; // entry attempts without an answer before the joining screen explains why

const $ = id => document.getElementById(id);
const els = {
	status: $('status'),
	statusText: $('status-text'),
	rtt: $('rtt'),
	route: $('route'),
	openSettings: $('open-settings'),
	leave: $('leave'),
	banner: $('banner'),
	bannerText: $('banner-text'),
	bannerAction: $('banner-action'),
	notice: $('notice'),
	noticeText: $('notice-text'),
	noticeSave: $('notice-save'),
	noticeDismiss: $('notice-dismiss'),
	start: $('view-start'),
	startRoot: $('start-root'),
	message: $('view-message'),
	msgSpinner: $('msg-spinner'),
	msgTitle: $('msg-title'),
	msgText: $('msg-text'),
	msgServer: $('msg-server'),
	msgActions: $('msg-actions'),
	session: $('view-session'),
	roomBar: $('room-bar'),
	toolHost: $('tool-host'),
	settings: $('view-settings'),
	tabs: $('tabs'),
};

// A room link opens that room (and leaves the address bar clean); otherwise the room this device had open.
const link = parseLink(location.hash);
let bootError = null;
if (link.kind !== 'none' || new URLSearchParams(location.search).has('share')) history.replaceState(null, '', cleanUrl());
if (link.kind === 'legacy') bootError = 'legacy-link';
else if (link.kind === 'room' && link.error) bootError = link.error;
else if (link.kind === 'room') roomStore.open({ code: link.code, profile: link.profile ?? PUBLIC_PROFILE, turn: link.turn });

const entry = bootError ? null : roomStore.current;
const code = entry?.code ?? null;
const profile = entry?.profile ?? null;
const ice = new IceConfig({ base: profile?.iceServers ?? null });
if (entry?.turn) ice.adopt(entry.turn);
const room = entry
	? new Room({
		code,
		// peerjs keeps this config object, so new TURN credentials reach later connections.
		peerOptions: { ...peerOptions(profile), config: ice.config },
		ice,
		known: entry.known,
	})
	: null;

const voice = room ? new Voice(room) : null;

let everOpen = false;
let toolsMounted = false;
let tabsReady = false;
let settingsOpen = false;
let noticeDismissed = false;
let claim = 0;
let knownNames = '';
let inviteDialog = null;
let activeBeforeSettings = null;
let sharePending = null; // what "Share → PeerKit" handed over, waiting for the Transfer tool
let shareWaiting = null; // the same share, described, while there is no room to send it to
const shareListeners = new Set();

const settingsView = new SettingsView(els.settings, { onClose: closeSettings, sessionProfile: () => profile, ice });
if (!room && !bootError) {
	new StartView(els.startRoot, {
		onCreate: createRoom,
		onJoin: code => openRoom({ code, profile: roomStore.find(code)?.profile ?? profiles.active }),
		onJoinLink: hash => location.assign(`${location.pathname}${location.search}${hash}`),
		onOpen: saved => openRoom(saved),
		onForget: forgetRoom,
		onChangeServer: openSettings,
	});
}

if (room) {
	room.on('state', onRoomState);
	room.on('members', onMembers);
	room.on('rtt', () => {
		renderRtt();
		renderRoomBar();
	});
	room.on('turn', turn => roomStore.update(code, { turn }));
	ice.on('change', () => room.shareTurn()); // renewed credentials
	voice.on('change', renderRoomBar);
	window.peerkit = room; // handy for debugging from the console
}
profiles.on('change', renderNotice);
registerServiceWorker();
// A share is taken out of the cache only once a room is open, so it survives the reload that opening one does.
if (!room) peekShare().then(share => {
	shareWaiting = share;
	render();
});

// Opening another room link in this tab starts over with it.
window.addEventListener('hashchange', () => location.reload());
window.addEventListener('pagehide', () => {
	voice?.destroy();
	room?.destroy();
});
window.addEventListener('pageshow', e => {
	if (e.persisted) location.reload();
});
// Don't wait for timers that were throttled while the phone was locked or offline.
document.addEventListener('visibilitychange', () => {
	if (document.visibilityState !== 'visible') return;
	ice.refresh();
	room?.checkHealth();
});
window.addEventListener('online', () => room?.checkHealth());
setInterval(() => ice.refresh(), ICE_REFRESH_EVERY);
// Settings is a history entry, so the Android back gesture closes it.
if (history.state?.peerkitSettings) history.replaceState(null, '');
window.addEventListener('popstate', () => setSettingsOpen(history.state?.peerkitSettings === true));

els.openSettings.append(icon('settings'));
els.openSettings.addEventListener('click', () => (settingsOpen ? closeSettings() : openSettings()));
els.leave.addEventListener('click', showLeave);
els.noticeDismiss.append(icon('close'));
els.noticeDismiss.addEventListener('click', () => {
	noticeDismissed = true;
	renderNotice();
});
els.noticeSave.addEventListener('click', () => {
	try {
		toast(`Saved “${profiles.save(profile).name}”`);
	} catch (err) {
		toast(err.message);
	}
});

const iceReady = ice.prepare();
if (room) claimAndStart();
render();

/** One open room per device: two tabs would join the same rooms twice. */
async function claimAndStart(steal = false) {
	const mine = ++claim;
	const ok = await claimTab('peerkit:room', {
		steal,
		onLost: () => {
			if (mine === claim) room.stop('moved-tab');
		},
	});
	if (mine !== claim) return;
	await iceReady; // TURN credentials must be in the config before the Peer exists
	if (mine !== claim) return;
	if (!ok) room.stop('other-tab');
	else if (steal) room.retry();
	else room.start();
}

function onRoomState(state) {
	if (state === 'open') {
		if (!everOpen) {
			everOpen = true;
			roomStore.update(code, { known: true });
			mountTools();
		}
		if (sessionStorage.getItem(INVITE_KEY) === code) {
			sessionStorage.removeItem(INVITE_KEY);
			showInvite();
		}
	}
	render();
}

function onMembers() {
	const names = room.members.map(member => member.name);
	const key = [...names].sort().join('\n');
	if (names.length && key !== knownNames) {
		knownNames = key;
		roomStore.update(code, { names });
	}
	render();
}

// --- rendering ---

function render() {
	let view;
	let banner = null;
	if (bootError) {
		view = 'message';
		const { title, text } = describeError(bootError);
		showMessage({ title, text, server: false, actions: [button('Start page', null, goToStart, 'btn primary')] });
	} else if (!room) {
		view = 'start';
		banner = shareBanner();
	} else if (!everOpen) {
		view = 'message';
		renderJoining();
	} else {
		view = 'session';
		banner = roomBanner();
	}
	if (settingsOpen) {
		view = 'settings';
		banner = null;
	}
	els.start.hidden = view !== 'start';
	els.message.hidden = view !== 'message';
	els.session.hidden = view !== 'session';
	els.settings.hidden = view !== 'settings';
	els.tabs.hidden = !tabsReady || view !== 'session';
	renderStatus();
	renderRoomBar();
	renderBanner(banner);
	renderNotice();
}

function renderStatus() {
	const state = room?.state ?? 'idle';
	const others = room?.members.length ?? 0;
	els.status.hidden = !room;
	els.leave.hidden = !room;
	els.status.dataset.state = state === 'failed' ? 'failed' : state !== 'open' ? 'pending' : others ? 'connected' : 'waiting';
	els.statusText.textContent = statusText(state, others);
	els.openSettings.setAttribute('aria-pressed', String(settingsOpen));
	renderRtt();
}

function statusText(state, others) {
	switch (state) {
		case 'open':
			return others ? `${others + 1} in the room` : 'Only you';
		case 'joining':
			return 'Looking for the room…';
		case 'failed':
			return 'Not connected';
		default:
			return 'Connecting to server…';
	}
}

/** Round-trip time and route in the top bar when there is exactly one other member; the member chips show them otherwise. */
function renderRtt() {
	const [only, ...more] = room?.state === 'open' ? room.members : [];
	const show = Boolean(only) && !more.length;
	els.rtt.hidden = !show || only.rtt == null;
	if (!els.rtt.hidden) els.rtt.textContent = `${only.rtt} ms`;
	els.route.hidden = !show || !only.route;
	if (els.route.hidden) return;
	const { relayed, protocol } = only.route;
	els.route.textContent = relayed ? 'Relayed' : 'Direct';
	els.route.dataset.relayed = String(relayed);
	els.route.title = relayed ? `Through a TURN server${protocol ? ` (${protocol.toUpperCase()})` : ''}` : 'Direct connection between the devices';
}

function renderRoomBar() {
	if (!room || !everOpen) return;
	const chip = (member, label, title, mark) => h('span', { class: 'member-chip', 'data-voice': mark, style: `--who: ${member.color}`, title },
		mark ? icon(mark === 'muted' ? 'mic-off' : 'mic') : null,
		label);
	const members = room.members;
	const chips = [chip(room.self, 'You', `${room.self.name} (this device)`, voice.selfMark)];
	for (const member of members) {
		const route = member.route ? (member.route.relayed ? 'relayed' : 'direct') : null;
		const details = [member.rtt != null && `${member.rtt} ms`, route].filter(Boolean).join(', ');
		chips.push(chip(member, member.name, details ? `${member.name}: ${details}` : member.name, voice.mark(member.peerId)));
	}
	const connecting = room.connecting;
	els.roomBar.replaceChildren(
		h('div', { class: 'members', role: 'list', 'aria-label': 'People in the room' }, chips),
		connecting ? h('span', { class: 'members-note' }, `Connecting to ${connecting}…`) : null,
		!members.length && !connecting ? h('span', { class: 'members-note' }, 'Nobody else is here yet') : null,
		button('Invite', 'share', showInvite, `btn small${members.length ? '' : ' primary'} push`),
		renderVoice());
}

// --- voice ---

/** The voice row: one tap from every tool, because muting must never be somewhere else. */
function renderVoice() {
	const others = voice.others.length;
	if (!voice.active) {
		return h('div', { class: 'voice-bar' },
			button(voice.busy ? 'Asking…' : 'Join voice', 'mic', joinVoice, `btn small${others ? ' primary' : ''}`),
			h('span', { class: 'voice-note' }, others ? `${others} in voice` : 'Nobody is talking yet'));
	}
	const bits = others ? [`${voice.count} in voice`] : ['Waiting for someone to join voice'];
	if (voice.listening) bits.push('listening only');
	// Say so while someone's audio is missing, instead of counting them in as if they could be heard.
	if (voice.waiting.length) bits.push(others > 1 ? `connecting to ${voice.waiting.length}…` : 'connecting…');
	const note = bits.join(' · ');
	return h('div', { class: 'voice-bar', 'data-mine': voice.selfMark },
		voice.listening
			? button('Use microphone', 'mic', useMicrophone, 'btn small')
			: button(voice.muted ? 'Unmute' : 'Mute', voice.muted ? 'mic-off' : 'mic', () => voice.toggleMute(), `btn small${voice.muted ? ' primary' : ''}`),
		h('span', { class: 'voice-note' }, note),
		voice.blocked ? button('Tap for sound', 'volume-x', () => voice.resumeAudio(), 'btn small primary') : null,
		others ? h('button', { type: 'button', class: 'icon-btn small', title: 'Voice settings', 'aria-label': 'Voice settings', onclick: showVoiceSheet }, icon('chevron-down')) : null,
		button('Leave voice', null, () => voice.leave(), 'btn small ghost push'));
}

async function joinVoice() {
	const note = await voice.join();
	if (note) toast(note);
}

async function useMicrophone() {
	const note = await voice.useMicrophone();
	if (note) toast(note);
}

/** Per-member volume, a local mute and the microphone to use: settings for this device only. */
function showVoiceSheet() {
	const list = h('ul', { class: 'voice-list' });
	const mics = h('div', { class: 'field' });
	const dialog = openDialog(h('div', { class: 'sheet-body' },
		h('h2', {}, 'Voice'),
		list,
		mics,
		h('p', { class: 'hint' }, 'Volume and mute are for this device: the others still hear that person.'),
		h('div', { class: 'actions end' }, button('Done', null, () => dialog.close(), 'btn ghost'))));

	const renderList = () => {
		const others = voice.others;
		if (!others.length) {
			list.replaceChildren(h('li', { class: 'hint' }, 'Nobody else is in voice.'));
			return;
		}
		list.replaceChildren(...others.map(peer => {
			const off = voice.mutedFor(peer.deviceId);
			const color = room.member(peer.peerId)?.color;
			const slider = h('input', {
				type: 'range',
				min: '0',
				max: '100',
				value: String(Math.round(voice.volumeOf(peer.deviceId) * 100)),
				'aria-label': `Volume for ${peer.name}`,
				disabled: off,
				oninput: e => voice.setVolume(peer.deviceId, Number(e.target.value) / 100),
			});
			const status = voice.statusOf(peer);
			return h('li', { class: 'voice-row' },
				h('span', { class: 'voice-name', style: color ? `--who: ${color}` : null },
					peer.name,
					status ? h('small', {}, status) : null),
				h('button', {
					type: 'button',
					class: 'icon-btn small',
					title: off ? `Hear ${peer.name} again` : `Mute ${peer.name} here`,
					'aria-pressed': String(off),
					onclick: () => {
						voice.setPeerMuted(peer.deviceId, !off);
						renderList();
					},
				}, icon(off ? 'volume-x' : 'volume')),
				slider);
		}));
	};
	renderList();

	voice.microphones().then(list => {
		if (list.length < 2 || !dialog.open) return;
		mics.replaceChildren(
			h('span', {}, 'Microphone'),
			h('select', { class: 'input select', onchange: e => voice.setMicrophone(e.target.value).then(note => note && toast(note)) },
				list.map(mic => h('option', { value: mic.id, selected: mic.id === voice.prefs.mic }, mic.label))),
			h('small', {}, 'A headset that is connected while you talk shows up here.'));
	});

	const offMembers = room.on('members', renderList);
	const offVoice = voice.on('change', renderList);
	dialog.addEventListener('close', () => {
		offMembers();
		offVoice();
	});
}

function renderJoining() {
	const { state, error } = room;
	if (state === 'failed') {
		const { title, text } = describeError(error);
		showMessage({ title, text, server: !DEAD_ENDS.has(error), actions: errorActions(error) });
		return;
	}
	if (state === 'joining') {
		const slow = room.entryFailures >= SLOW_LOOKUP;
		showMessage({
			spinner: true,
			title: 'Looking for the room…',
			text: slow
				? 'No answer yet. If someone’s device just dropped off the network, the server can take up to 2 minutes to notice. On strict networks a TURN server (Settings) may be needed.'
				: `Room ${code}`,
			actions: [button('Back', null, goToStart, 'btn')],
		});
		return;
	}
	showMessage({ spinner: true, title: 'Connecting…', text: 'Connecting to the signaling server.', actions: [button('Back', null, goToStart, 'btn')] });
}

/** What the user can do about an error, most useful first. */
function errorActions(error) {
	const back = button('Back', null, goToStart, 'btn');
	switch (error) {
		case 'other-tab':
		case 'moved-tab':
			return [button('Use this tab', null, () => claimAndStart(true), 'btn primary'), back];
		case 'not-found':
			return [button('Wait in this room', null, () => room.waitHere(), 'btn primary'), button('Try again', null, () => room.retry(), 'btn'), back];
		case 'browser-incompatible':
			return [back];
		default: {
			const actions = [button('Try again', null, () => room.retry(), 'btn primary')];
			if (SERVER_ERRORS.has(error)) actions.push(button('Server settings', null, openSettings, 'btn'));
			return [...actions, back];
		}
	}
}

function roomBanner() {
	const { state, error } = room;
	if (state === 'failed') {
		const { title, text } = describeError(error);
		const [action] = errorActions(error);
		return { kind: 'bad', text: `${title}. ${text}`, action: action && [action.textContent, () => action.click()] };
	}
	if (room.signalingLost) {
		return { text: 'Server connection lost. People already here stay connected; nobody new can join until it is back.' };
	}
	return null;
}

function showMessage({ spinner = false, title, text, server = true, actions = [] }) {
	els.msgSpinner.hidden = !spinner;
	els.msgTitle.textContent = title;
	els.msgText.textContent = text;
	els.msgServer.hidden = !server || !profile;
	if (profile) els.msgServer.textContent = `Server: ${profile.name}`;
	els.msgActions.replaceChildren(...actions);
}

function renderBanner(banner) {
	els.banner.hidden = !banner;
	if (!banner) return;
	els.banner.dataset.kind = banner.kind ?? 'warn';
	els.bannerText.textContent = banner.text;
	els.bannerAction.hidden = !banner.action;
	if (banner.action) {
		els.bannerAction.textContent = banner.action[0];
		els.bannerAction.onclick = banner.action[1];
	}
}

/** Offer to save the server of a room that came with a link, unless this device already has it. */
function renderNotice() {
	const show = Boolean(profile) && !isPublic(profile) && !noticeDismissed && !settingsOpen && !profiles.findSame(profile);
	els.notice.hidden = !show;
	if (show) els.noticeText.textContent = `This room uses the server “${profile.name}”.`;
}

// --- room actions ---

function showInvite() {
	if (!room) return;
	inviteDialog?.close();
	const url = roomLink({ code, profile, turn: ice.forRoom });
	const qr = h('div', { class: 'qr', role: 'img', 'aria-label': 'QR code with the room link' });
	const linkInput = h('input', { class: 'link', type: 'text', readonly: true, value: url, 'aria-label': 'Room link', onfocus: () => linkInput.select() });
	const dialog = (inviteDialog = openDialog(h('div', { class: 'sheet-body invite' },
		h('h2', {}, 'Invite to this room'),
		h('p', { class: 'room-code' }, code),
		qr,
		linkInput,
		h('div', { class: 'actions' },
			button('Copy link', 'copy', async () => toast((await copyText(url)) ? 'Link copied' : 'Copy failed'), 'btn primary'),
			button('Copy code', 'copy', async () => toast((await copyText(code)) ? 'Code copied' : 'Copy failed'), 'btn'),
			navigator.share && button('Share…', 'share', () => navigator.share({ title: 'PeerKit room', text: 'Join my PeerKit room', url }).catch(() => {}), 'btn')),
		h('p', { class: 'hint' },
			`Scan the QR code, open the link, or type the code in PeerKit → Join. Up to ${MAX_MEMBERS} devices. `,
			'Anyone with the code can join, read the documents and come back later. To leave someone out, make a new room.'),
		h('p', { class: 'server-line' }, 'Server: ', h('strong', {}, profile.name)),
		h('div', { class: 'actions end' }, button('Done', null, () => dialog.close(), 'btn ghost')))));
	renderQR(qr, url);
	dialog.addEventListener('close', () => {
		if (inviteDialog === dialog) inviteDialog = null;
	});
}

function showLeave() {
	if (!room) return;
	const dialog = openDialog(h('div', { class: 'sheet-body' },
		h('h2', {}, 'Leave this room?'),
		h('p', { class: 'hint' }, 'The others stay in the room. You can come back from Recent rooms or with the code.'),
		h('p', { class: 'hint' }, '“Leave and forget” also deletes the room’s documents from this device; the others keep theirs.'),
		h('div', { class: 'actions end' },
			button('Cancel', null, () => dialog.close(), 'btn ghost'),
			button('Leave and forget', 'trash', () => leaveRoom(true), 'btn danger'),
			button('Leave', null, () => leaveRoom(false), 'btn primary'))));
}

async function leaveRoom(forget) {
	voice.leave(); // the microphone indicator must go out with the room
	await room.leave();
	sessionStorage.removeItem(INVITE_KEY);
	if (forget) {
		roomStore.forget(code);
		await deleteRoomData(code);
	} else {
		roomStore.leave();
	}
	reloadClean();
}

function createRoom() {
	const code = newRoomCode();
	roomStore.open({ code, profile: profiles.active, known: true });
	sessionStorage.setItem(INVITE_KEY, code);
	reloadClean();
}

function openRoom({ code, profile }) {
	roomStore.open({ code, profile });
	reloadClean();
}

async function forgetRoom(saved) {
	if (!confirm(`Forget the room ${saved.code}?\n\nIts documents are deleted from this device. The others in the room keep theirs.`)) return;
	roomStore.forget(saved.code);
	await deleteRoomData(saved.code);
	toast('Room forgotten');
}

/** Delete what this device keeps for a room (the editor's IndexedDB database). */
function deleteRoomData(code) {
	return new Promise(resolve => {
		setTimeout(resolve, 2000); // a blocked database never answers
		try {
			const request = indexedDB.deleteDatabase(`peerkit.doc:${roomIds(code).id}`);
			request.onsuccess = request.onerror = request.onblocked = () => resolve();
		} catch {
			resolve();
		}
	});
}

/** Back to the start screen. A room that never opened here and wasn't known is dropped from the list. */
async function goToStart() {
	if (room) {
		voice.destroy();
		room.destroy();
		if (!everOpen && !roomStore.find(code)?.known) roomStore.forget(code);
		else roomStore.leave();
	}
	reloadClean();
}

function reloadClean() {
	history.replaceState(null, '', cleanUrl());
	location.reload();
}

/** The address bar without a room link and without the marker the share target adds. */
function cleanUrl() {
	const params = new URLSearchParams(location.search);
	params.delete('share');
	const search = params.toString();
	return location.pathname + (search ? `?${search}` : '');
}

// --- the Android share target ---

function offerShare() {
	if (!sharePending || !shareListeners.size) return;
	const share = sharePending;
	sharePending = null;
	for (const fn of shareListeners) fn(share);
}

/** On the start screen a share has nowhere to go yet, so it waits in the cache and says so. */
function shareBanner() {
	if (!shareWaiting) return null;
	const { files, text } = shareWaiting;
	const what = files.length
		? `${files.length === 1 ? files[0].name : `${files.length} files`}${text ? ' and text' : ''}`
		: 'Shared text';
	return {
		kind: 'info',
		text: `${what} is waiting. Open a room to send it.`,
		action: ['Discard', async () => {
			shareWaiting = null;
			await dropShare();
			render();
		}],
	};
}

// --- settings ---

function openSettings() {
	if (settingsOpen) return;
	history.pushState({ peerkitSettings: true }, '');
	setSettingsOpen(true);
}

function closeSettings() {
	if (history.state?.peerkitSettings) history.back(); // popstate finishes closing
	else setSettingsOpen(false);
}

function setSettingsOpen(open) {
	if (open === settingsOpen) return;
	settingsOpen = open;
	if (open) {
		activeBeforeSettings = profiles.active;
		settingsView.show();
	} else {
		settingsView.hide();
		const active = profiles.active;
		if (room && !sameConnection(active, activeBeforeSettings) && !sameConnection(active, profile)) {
			toast('A room stays on its own server. The selected server is used for new rooms.');
		}
	}
	render();
}

// --- tools ---

function mountTools() {
	if (toolsMounted) return;
	toolsMounted = true;
	takeShare().then(share => {
		sharePending = share;
		offerShare();
	});
	const panels = TOOLS.map(tool => h('section', { class: 'tool', 'data-tool': tool.id }));
	const tabs = TOOLS.map((tool, i) => h('button', { type: 'button', onclick: () => select(i) }, tool.title));
	const showListeners = TOOLS.map(() => new Set());
	const select = index => {
		panels.forEach((panel, i) => {
			const hidden = i !== index;
			if (panel.hidden === hidden) return;
			panel.hidden = hidden;
			if (!hidden) showListeners[i].forEach(fn => fn());
		});
		tabs.forEach((tab, i) => tab.setAttribute('aria-current', String(i === index)));
		tabs[index].classList.remove('notify');
	};
	els.toolHost.append(...panels);
	if (TOOLS.length > 1) {
		els.tabs.replaceChildren(...tabs);
		tabsReady = true;
	}
	select(0);
	TOOLS.forEach((tool, i) => tool.mount(panels[i], room, {
		// Tools that keep data per room (the editor's documents) key it by the room ID, the same on every device.
		room: roomIds(code).id,
		/** Bring this tool to the front, e.g. when someone starts a stream. */
		activate: () => select(i),
		/** Mark the tab when something arrived while another tool is shown. */
		notify: () => {
			if (panels[i].hidden) tabs[i].classList.add('notify');
		},
		visible: () => !panels[i].hidden,
		/** The room's voice: a tool that carries audio of its own mutes it while this is on. */
		voiceActive: () => voice.active,
		onVoiceChange: fn => voice.on('change', fn),
		/** What Android's "Share → PeerKit" handed over, delivered once, to the tool that asks for it. */
		onShare: fn => {
			shareListeners.add(fn);
			offerShare();
			return () => shareListeners.delete(fn);
		},
		/** Called each time the tool's tab is opened; returns an unsubscribe function. */
		onShow: fn => {
			showListeners[i].add(fn);
			return () => showListeners[i].delete(fn);
		},
	}));
}
