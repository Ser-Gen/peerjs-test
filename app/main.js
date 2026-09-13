import { Session, describeError } from './session.js';
import { decodeProfile, encodeProfile, isPublic, peerOptions, profiles, sameConnection } from './settings.js';
import { button, h, icon, toast } from './ui/dom.js';
import { renderQR } from './ui/qr.js';
import { SettingsView } from './ui/settings-view.js';
import { copyText } from './util.js';
import transfer from './tools/transfer.js';

const TOOLS = [transfer].filter(tool => tool.supported());

const PEER_ID_RE = /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/; // the rule peerjs applies
// Retrying can't fix these.
const FATAL_ERRORS = new Set(['bad-link', 'invalid-id', 'browser-incompatible']);
const SERVER_ERRORS = new Set(['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected', 'invalid-key', 'ssl-unavailable']);

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
	qr: $('qr'),
	pairServer: $('pair-server'),
	link: $('link'),
	copyLink: $('copy-link'),
	shareLink: $('share-link'),
	backToSession: $('back-to-session'),
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
// The server this session runs on: the one from the link for a guest, otherwise the active profile.
let profile = link.profile ?? profiles.active;
const session = new Session({ joinId: link.joinId, peerOptions: peerOptions(profile) });
const settingsView = new SettingsView(els.settings, { onClose: closeSettings, sessionProfile: () => profile });

let showPair = false;
let renderedLink = null;
let toolsMounted = false;
let tabsReady = false;
let settingsOpen = false;
let noticeDismissed = false;

session.on('state', render);
session.on('rtt', renderRtt);
profiles.on('change', renderNotice);

// Opening another join link in this tab starts over with it.
window.addEventListener('hashchange', () => location.reload());
window.addEventListener('pagehide', () => session.destroy());
window.addEventListener('pageshow', e => {
	if (e.persisted) location.reload();
});
// Settings is a history entry, so the Android back gesture closes it.
if (history.state?.peerkitSettings) history.replaceState(null, '');
window.addEventListener('popstate', () => setSettingsOpen(history.state?.peerkitSettings === true));

els.openSettings.append(icon('settings'));
els.openSettings.addEventListener('click', () => (settingsOpen ? closeSettings() : openSettings()));
els.leave.addEventListener('click', leave);
els.link.addEventListener('focus', () => els.link.select());
els.copyLink.addEventListener('click', async () => toast((await copyText(sessionLink())) ? 'Link copied' : 'Copy failed'));
if (navigator.share) {
	els.shareLink.hidden = false;
	els.shareLink.addEventListener('click', () => {
		navigator.share({ title: 'PeerKit', text: 'Join my PeerKit session', url: sessionLink() }).catch(() => {});
	});
}
els.backToSession.addEventListener('click', () => {
	showPair = false;
	render();
});
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
else session.start();
render();

function parseLink(hash) {
	const params = new URLSearchParams(hash.slice(1));
	const joinId = params.get('join');
	if (joinId == null) return { joinId: null, profile: null, error: null };
	if (!PEER_ID_RE.test(joinId)) return { joinId, profile: null, error: 'invalid-id' };
	if (!params.has('s')) return { joinId, profile: null, error: null };
	try {
		return { joinId, profile: decodeProfile(params.get('s')), error: null };
	} catch (err) {
		console.warn('[peerkit] bad server settings in link:', err.message);
		return { joinId, profile: null, error: 'bad-link' };
	}
}

function sessionLink() {
	const base = `${location.origin}${location.pathname}#join=${encodeURIComponent(session.id)}`;
	// The public server is the default on both ends, so leaving it out keeps the QR small.
	return isPublic(profile) ? base : `${base}&s=${encodeProfile(profile)}`;
}

function render() {
	const { state, error, role, everConnected } = session;
	if (state === 'connected') {
		showPair = false;
		mountTools();
	}

	els.status.dataset.state = state;
	els.statusText.textContent = statusText();
	els.leave.textContent = role === 'guest' ? 'Leave' : 'New session';
	els.openSettings.setAttribute('aria-pressed', String(settingsOpen));
	renderRtt();

	let view = 'message';
	let banner = null;
	switch (state) {
		case 'idle':
		case 'starting':
			if (everConnected) {
				view = 'session';
				banner = { text: 'Reconnecting…' };
			} else {
				showMessage({ spinner: true, title: role === 'guest' ? 'Joining…' : 'Starting…', text: 'Connecting to the signaling server.' });
			}
			break;
		case 'waiting':
			if (everConnected && !showPair) {
				view = 'session';
				banner = { text: 'The other device disconnected. Waiting for it to come back…', action: ['Show QR', () => { showPair = true; render(); }] };
			} else {
				view = 'pair';
				renderPair();
			}
			break;
		case 'connecting':
			if (everConnected) {
				view = 'session';
				banner = { text: 'Reconnecting…' };
			} else {
				showMessage({ spinner: true, title: 'Connecting to host…', text: 'Setting up a direct connection between the devices.' });
			}
			break;
		case 'connected':
			view = 'session';
			break;
		case 'failed': {
			const { title, text } = describeError(error);
			const fatal = FATAL_ERRORS.has(error);
			if (everConnected && !fatal) {
				view = 'session';
				banner = { kind: 'bad', text: `${title}. ${text}`, action: ['Try again', () => session.retry()] };
			} else {
				showMessage({
					title,
					text,
					server: !fatal,
					actions: [
						!fatal && button('Try again', null, () => session.retry(), 'btn primary'),
						role === 'guest' && button('Start my own session', null, startOver, fatal ? 'btn primary' : 'btn'),
						SERVER_ERRORS.has(error) && !link.profile && button('Server settings', null, openSettings, 'btn'),
					],
				});
			}
			break;
		}
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
	els.backToSession.hidden = !everConnected;
	renderBanner(banner);
	renderNotice();
}

function statusText() {
	switch (session.state) {
		case 'waiting':
			return session.everConnected ? 'Waiting for reconnect' : 'Waiting for a device';
		case 'connecting':
			return 'Connecting…';
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

function renderPair() {
	els.pairServer.replaceChildren(
		'Server: ',
		h('strong', {}, profile.name),
		' · ',
		h('button', { type: 'button', class: 'link-btn', onclick: openSettings }, 'Change'));
	if (!session.id) return;
	const url = sessionLink();
	if (url === renderedLink) return;
	renderedLink = url;
	renderQR(els.qr, url);
	els.link.value = url;
}

function showMessage({ spinner = false, title, text, server = true, actions = [] }) {
	els.msgSpinner.hidden = !spinner;
	els.msgTitle.textContent = title;
	els.msgText.textContent = text;
	els.msgServer.hidden = !server;
	els.msgServer.textContent = `Server: ${profile.name}`;
	els.msgActions.replaceChildren(...actions.filter(Boolean));
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
	if (link.profile) return; // a guest keeps the server from its link
	const next = profiles.active;
	if (sameConnection(next, profile)) {
		profile = next; // a rename only changes the name shown and put in the link
		return;
	}
	if (!session.everConnected) {
		location.reload(); // nothing to lose yet: restart on the new server with a fresh QR
		return;
	}
	toast('The new server will be used for the next session');
}

function mountTools() {
	if (toolsMounted) return;
	toolsMounted = true;
	const panels = TOOLS.map(tool => {
		const panel = h('section', { class: 'tool', 'data-tool': tool.id });
		els.toolHost.append(panel);
		tool.mount(panel, session);
		return panel;
	});
	if (TOOLS.length < 2) return;

	const tabs = TOOLS.map((tool, i) => h('button', { type: 'button', onclick: () => select(i) }, tool.title));
	const select = index => {
		panels.forEach((panel, i) => (panel.hidden = i !== index));
		tabs.forEach((tab, i) => tab.setAttribute('aria-current', String(i === index)));
	};
	els.tabs.replaceChildren(...tabs);
	tabsReady = true;
	select(0);
}

function leave() {
	const question = session.role === 'guest' ? 'Leave this session?' : 'Start a new session? The current connection will be closed.';
	if (session.state === 'connected' && !confirm(question)) return;
	startOver();
}

function startOver() {
	session.destroy();
	history.replaceState(null, '', location.pathname + location.search);
	location.reload();
}
