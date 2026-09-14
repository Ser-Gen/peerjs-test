import { device } from './device.js';
import { hostPeerId, joinLink, parseLink, recentHosts, rooms } from './rooms.js';
import { Session, describeError } from './session.js';
import { PUBLIC_PROFILE, peerOptions, profiles, sameConnection, serverKey } from './settings.js';
import { button, h, icon, openDialog, toast } from './ui/dom.js';
import { PairView } from './ui/pair-view.js';
import { SettingsView } from './ui/settings-view.js';
import { claimTab } from './util.js';
import stream from './tools/stream.js';
import transfer from './tools/transfer.js';

const TOOLS = [transfer, stream].filter(tool => tool.supported());

// Retrying can't fix these.
const FATAL_ERRORS = new Set(['bad-link', 'invalid-id', 'browser-incompatible']);
const SERVER_ERRORS = new Set(['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected', 'invalid-key', 'ssl-unavailable']);
// How long the server may keep refusing the room code before a new one is suggested.
const NEW_CODE_AFTER = 60000;
const TITLE = document.title;

const $ = id => document.getElementById(id);
const els = {
	status: $('status'),
	statusText: $('status-text'),
	rtt: $('rtt'),
	openSettings: $('open-settings'),
	leave: $('leave'),
	banner: $('banner'),
	bannerText: $('banner-text'),
	bannerAction: $('banner-action'),
	notice: $('notice'),
	noticeText: $('notice-text'),
	noticeSave: $('notice-save'),
	noticeDismiss: $('notice-dismiss'),
	pair: $('view-pair'),
	pairRoot: $('pair-root'),
	message: $('view-message'),
	msgSpinner: $('msg-spinner'),
	msgTitle: $('msg-title'),
	msgText: $('msg-text'),
	msgServer: $('msg-server'),
	msgActions: $('msg-actions'),
	session: $('view-session'),
	toolHost: $('tool-host'),
	settings: $('view-settings'),
	tabs: $('tabs'),
};

const link = parseLink(location.hash);
const role = link.isJoin ? 'guest' : 'host';
// The server this session runs on. A guest follows its link (no `s` = the public server); a host uses the active profile.
let profile = role === 'guest' ? (link.profile ?? PUBLIC_PROFILE) : profiles.active;
const room = role === 'host' ? rooms.get(profile) : null;
const code = room?.code ?? link.code;
const session = new Session({
	role,
	peerId: code ? hostPeerId(code) : null,
	// A typed code carries no token, but this device may have one from joining before.
	token: room?.token ?? link.token ?? (code ? recentHosts.find(profile, code)?.token : null) ?? null,
	peerOptions: peerOptions(profile),
	isTrusted: remote => rooms.isTrusted(profile, remote.deviceId),
});

let showPair = false;
let toolsMounted = false;
let tabsReady = false;
let settingsOpen = false;
let noticeDismissed = false;
let approval = null; // { request, dialog } while the host asks whether to let a device in
let claim = 0;

const settingsView = new SettingsView(els.settings, { onClose: closeSettings, sessionProfile: () => profile });
const pairView = role === 'host'
	? new PairView(els.pairRoot, {
		onJoin: join,
		onChangeServer: openSettings,
		onNewCode: newCode,
		onBack: () => {
			showPair = false;
			render();
		},
	})
	: null;

session.on('state', render);
session.on('rtt', renderRtt);
session.on('paired', onPaired);
session.on('left', () => {
	showPair = true; // the guest left on purpose: show the code again instead of "waiting for it to come back"
});
session.on('approval', askApproval);
session.on('approval-end', request => {
	if (approval?.request === request) approval.dialog.close();
});
profiles.on('change', renderNotice);

// Opening another join link in this tab starts over with it.
window.addEventListener('hashchange', () => location.reload());
window.addEventListener('pagehide', () => session.destroy());
window.addEventListener('pageshow', e => {
	if (e.persisted) location.reload();
});
// Don't wait for timers that were throttled while the phone was locked or offline.
document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'visible') session.checkHealth();
});
window.addEventListener('online', () => session.checkHealth());
// Settings is a history entry, so the Android back gesture closes it.
if (history.state?.peerkitSettings) history.replaceState(null, '');
window.addEventListener('popstate', () => setSettingsOpen(history.state?.peerkitSettings === true));

els.openSettings.append(icon('settings'));
els.openSettings.addEventListener('click', () => (settingsOpen ? closeSettings() : openSettings()));
els.leave.addEventListener('click', leave);
els.noticeDismiss.append(icon('close'));
els.noticeDismiss.addEventListener('click', () => {
	noticeDismissed = true;
	renderNotice();
});
els.noticeSave.addEventListener('click', () => {
	try {
		toast(`Saved “${profiles.save(link.profile).name}”`);
	} catch (err) {
		toast(err.message);
	}
});

window.peerkit = session; // handy for debugging from the console
if (link.error) session.fail(link.error);
else claimAndStart();
render();

/** One tab per session: two tabs would fight over the same peer ID or guest slot. */
async function claimAndStart(steal = false) {
	const mine = ++claim;
	const ok = await claimTab(`peerkit:${role}:${serverKey(profile)}:${code}`, {
		steal,
		onLost: () => {
			if (mine === claim) session.stop('moved-tab');
		},
	});
	if (mine !== claim) return;
	if (!ok) session.stop('other-tab');
	else if (steal) session.retry();
	else session.start();
}

function onPaired(remote) {
	if (role === 'host') rooms.trust(profile, remote);
	else recentHosts.touch({ code, token: session.token, name: remote.name, profile });
}

function askApproval(request) {
	approval?.dialog.close();
	const decide = allow => {
		if (allow) request.allow();
		else request.deny();
		dialog.close();
	};
	const dialog = openDialog(h('div', { class: 'sheet-body' },
		h('h2', {}, `Let “${request.name}” connect?`),
		h('p', { class: 'hint' }, 'This device entered your room code. Allow it only if you know it.'),
		h('p', { class: 'hint' }, 'Devices that scan your QR code or open your link connect without asking.'),
		h('div', { class: 'actions end' },
			button('Deny', null, () => decide(false), 'btn ghost'),
			button('Allow', null, () => decide(true), 'btn primary'))));
	approval = { request, dialog };
	document.title = `Allow device? · ${TITLE}`;
	navigator.vibrate?.(200);
	dialog.addEventListener('close', () => {
		request.deny(); // Esc or the back gesture means no; does nothing once answered
		if (approval?.dialog === dialog) approval = null;
		document.title = TITLE;
	});
}

function render() {
	const { state, everConnected } = session;
	if (state === 'connected') {
		showPair = false;
		mountTools();
	}

	els.status.dataset.state = state;
	els.statusText.textContent = statusText();
	els.leave.hidden = role === 'host' && state !== 'connected';
	els.leave.textContent = role === 'guest' ? 'Leave' : 'Disconnect';
	els.openSettings.setAttribute('aria-pressed', String(settingsOpen));
	renderRtt();

	let view = 'session';
	let banner = null;
	if (role === 'host' && state !== 'connected' && (!everConnected || showPair)) {
		view = 'pair';
		renderPair();
	} else if (role === 'guest' && !everConnected) {
		view = 'message';
		renderGuestMessage();
	} else {
		banner = sessionBanner();
	}

	if (settingsOpen) {
		view = 'settings';
		banner = null;
	}
	els.pair.hidden = view !== 'pair';
	els.message.hidden = view !== 'message';
	els.session.hidden = view !== 'session';
	els.settings.hidden = view !== 'settings';
	els.tabs.hidden = !tabsReady || view !== 'session';
	renderBanner(banner);
	renderNotice();
}

function statusText() {
	switch (session.state) {
		case 'waiting':
			return session.everConnected ? 'Waiting for reconnect' : 'Waiting for a device';
		case 'connecting':
			return session.everConnected ? 'Reconnecting…' : 'Connecting…';
		case 'reconnecting':
			return 'Reconnecting…';
		case 'pending':
			return 'Waiting for approval';
		case 'connected':
			return session.remote?.name ?? 'Connected';
		case 'failed':
			return 'Not connected';
		default:
			return 'Connecting to server…';
	}
}

function renderRtt() {
	const show = session.state === 'connected' && session.rtt != null;
	els.rtt.hidden = !show;
	if (show) els.rtt.textContent = `${session.rtt} ms`;
}

/** What the user can do about an error: [label, action] pairs, most useful first. */
function errorActions(error) {
	switch (error) {
		case 'other-tab':
		case 'moved-tab':
			return [['Use this tab', () => claimAndStart(true)]];
		case 'bad-link':
		case 'invalid-id':
		case 'browser-incompatible':
			return [];
		case 'ended':
			return [['Join again', () => session.retry()]];
		default:
			return [['Try again', () => session.retry()]];
	}
}

const actionButtons = actions => actions.map(([label, fn], i) => button(label, null, fn, i === 0 ? 'btn primary' : 'btn'));

function renderPair() {
	pairView.update({
		code,
		url: session.state === 'waiting' ? joinLink({ code, token: session.token, profile }) : null,
		profile,
		status: hostStatus(),
		showBack: session.everConnected,
	});
}

function hostStatus() {
	const { state, error } = session;
	if (state === 'waiting') return null;
	if (state === 'failed') {
		const { title, text } = describeError(error);
		const actions = actionButtons(errorActions(error));
		if (SERVER_ERRORS.has(error)) actions.push(button('Server settings', null, openSettings, 'btn'));
		return { title, text, actions };
	}
	if (session.idTakenSince != null) {
		const long = Date.now() - session.idTakenSince > NEW_CODE_AFTER;
		return {
			spinner: true,
			title: `Claiming ${code}…`,
			text: long
				? 'The server still reports this code as in use. Another device may have the same code, or PeerKit is open somewhere else.'
				: 'The server still holds this code from before the page was reloaded. This can take up to a minute.',
			actions: long ? [button('Use a new code', null, newCode, 'btn primary')] : [],
		};
	}
	return { spinner: true, title: 'Starting…', text: 'Connecting to the signaling server.' };
}

function renderGuestMessage() {
	const { state, error } = session;
	if (state === 'failed') {
		const { title, text } = describeError(error);
		const actions = actionButtons(errorActions(error));
		actions.push(button('Start over', null, startOver, actions.length ? 'btn' : 'btn primary'));
		showMessage({ title, text, server: !FATAL_ERRORS.has(error), actions });
	} else if (state === 'pending') {
		showMessage({ spinner: true, title: 'Waiting for approval', text: `Confirm “${device.name}” on the host screen.` });
	} else if (state === 'connecting') {
		showMessage({ spinner: true, title: `Joining ${code}…`, text: 'Setting up a direct connection between the devices.' });
	} else {
		showMessage({ spinner: true, title: 'Joining…', text: 'Connecting to the signaling server.' });
	}
}

function sessionBanner() {
	const { state, error } = session;
	const other = session.remote?.name ?? 'The other device';
	switch (state) {
		case 'connected':
			return null;
		case 'waiting':
			return { text: `${other} disconnected. Waiting for it to come back…`, action: ['Show code', () => { showPair = true; render(); }] };
		case 'pending':
			return { text: 'Waiting for the host to allow this device…' };
		case 'reconnecting':
			return {
				text: session.retryError === 'peer-unavailable' ? `${other} is not reachable. Retrying…` : 'Connection lost. Reconnecting…',
				action: ['Retry now', () => session.retry()],
			};
		case 'failed': {
			const { title, text } = describeError(error);
			return { kind: 'bad', text: `${title}. ${text}`, action: errorActions(error)[0] };
		}
		default:
			return { text: role === 'host' ? 'Reconnecting to the server…' : 'Reconnecting…' };
	}
}

function showMessage({ spinner = false, title, text, server = true, actions = [] }) {
	els.msgSpinner.hidden = !spinner;
	els.msgTitle.textContent = title;
	els.msgText.textContent = text;
	els.msgServer.hidden = !server;
	els.msgServer.textContent = `Server: ${profile.name}`;
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

/** Offer to save the server a guest got from the link, unless this device already has it. */
function renderNotice() {
	const show = Boolean(link.profile) && !noticeDismissed && !settingsOpen && !profiles.findSame(link.profile);
	els.notice.hidden = !show;
	if (show) els.noticeText.textContent = `This session uses the server “${link.profile.name}”.`;
}

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
	if (open) settingsView.show();
	else {
		settingsView.hide();
		applySettings();
	}
	render();
}

/** After leaving Settings: follow a change of the active server where that is safe. */
function applySettings() {
	if (role === 'guest') return; // a guest keeps the server from its link
	const next = profiles.active;
	if (sameConnection(next, profile)) {
		profile = next; // a rename only changes the name shown and put in the link
		return;
	}
	if (!session.everConnected) {
		location.reload(); // nothing to lose yet: restart on the new server with its own code
		return;
	}
	toast('The new server will be used for the next session');
}

function mountTools() {
	if (toolsMounted) return;
	toolsMounted = true;
	const panels = TOOLS.map(tool => h('section', { class: 'tool', 'data-tool': tool.id }));
	const tabs = TOOLS.map((tool, i) => h('button', { type: 'button', onclick: () => select(i) }, tool.title));
	const select = index => {
		panels.forEach((panel, i) => (panel.hidden = i !== index));
		tabs.forEach((tab, i) => tab.setAttribute('aria-current', String(i === index)));
		tabs[index].classList.remove('notify');
	};
	els.toolHost.append(...panels);
	if (TOOLS.length > 1) {
		els.tabs.replaceChildren(...tabs);
		tabsReady = true;
	}
	select(0);
	TOOLS.forEach((tool, i) => tool.mount(panels[i], session, {
		/** Bring this tool to the front, e.g. when the other device starts a stream. */
		activate: () => select(i),
		/** Mark the tab when something arrived while another tool is shown. */
		notify: () => {
			if (panels[i].hidden) tabs[i].classList.add('notify');
		},
	}));
}

async function leave() {
	if (role === 'guest') {
		if (session.state === 'connected' && !confirm('Leave this session?')) return;
		await session.leave();
		startOver();
		return;
	}
	const name = session.remote?.name ?? 'the other device';
	if (!confirm(`Disconnect ${name}?\n\nIt can connect again with your code, QR code or link.`)) return;
	await session.leave();
	showPair = true;
	render();
}

async function join(url) {
	if (session.state === 'connected') {
		if (!confirm('Leave the current session and join another host?')) return;
		await session.leave();
	}
	location.assign(url); // only the hash changes: the hashchange listener reloads the page as a guest
}

function newCode() {
	const connected = session.state === 'connected';
	const question = 'Create a new room code?\n\nThe current code, QR code and link stop working, and devices that joined before need the new code.'
		+ (connected ? ' The connected device will be disconnected.' : '');
	if (!confirm(question)) return;
	rooms.regenerate(profile);
	startOver();
}

function startOver() {
	session.destroy();
	history.replaceState(null, '', location.pathname + location.search);
	location.reload();
}
