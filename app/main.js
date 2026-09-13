import { Session, describeError } from './session.js';
import { button, h, toast } from './ui/dom.js';
import { renderQR } from './ui/qr.js';
import { copyText } from './util.js';
import transfer from './tools/transfer.js';

const TOOLS = [transfer].filter(tool => tool.supported());

const $ = id => document.getElementById(id);
const els = {
	status: $('status'),
	statusText: $('status-text'),
	rtt: $('rtt'),
	leave: $('leave'),
	banner: $('banner'),
	bannerText: $('banner-text'),
	bannerAction: $('banner-action'),
	pair: $('view-pair'),
	qr: $('qr'),
	link: $('link'),
	copyLink: $('copy-link'),
	shareLink: $('share-link'),
	backToSession: $('back-to-session'),
	message: $('view-message'),
	msgSpinner: $('msg-spinner'),
	msgTitle: $('msg-title'),
	msgText: $('msg-text'),
	msgActions: $('msg-actions'),
	session: $('view-session'),
	toolHost: $('tool-host'),
	tabs: $('tabs'),
};

const joinId = new URLSearchParams(location.hash.slice(1)).get('join');
const session = new Session({ joinId });

let showPair = false;
let renderedLink = null;
let toolsMounted = false;

session.on('state', render);
session.on('rtt', renderRtt);

// Opening another join link in this tab starts over with it.
window.addEventListener('hashchange', () => location.reload());
window.addEventListener('pagehide', () => session.destroy());
window.addEventListener('pageshow', e => {
	if (e.persisted) location.reload();
});

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

window.peerkit = session; // handy for debugging from the console
session.start();
render();

function sessionLink() {
	return `${location.origin}${location.pathname}#join=${encodeURIComponent(session.id)}`;
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
			if (everConnected) {
				view = 'session';
				banner = { kind: 'bad', text: `${title}. ${text}`, action: ['Try again', () => session.retry()] };
			} else {
				showMessage({
					title,
					text,
					actions: [
						button('Try again', null, () => session.retry(), 'btn primary'),
						role === 'guest' && button('Start my own session', null, startOver, 'btn'),
					],
				});
			}
			break;
		}
	}

	els.pair.hidden = view !== 'pair';
	els.message.hidden = view !== 'message';
	els.session.hidden = view !== 'session';
	els.backToSession.hidden = !everConnected;
	renderBanner(banner);
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
	if (!session.id) return;
	const link = sessionLink();
	if (link === renderedLink) return;
	renderedLink = link;
	renderQR(els.qr, link);
	els.link.value = link;
}

function showMessage({ spinner = false, title, text, actions = [] }) {
	els.msgSpinner.hidden = !spinner;
	els.msgTitle.textContent = title;
	els.msgText.textContent = text;
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
	els.tabs.hidden = false;
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
