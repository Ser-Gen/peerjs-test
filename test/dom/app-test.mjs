// The whole app (index.html + app/main.js) in jsdom on a fake peerjs network, with a headless second member.
// Usage: node app-test.mjs room | start | desktop
const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, ''); // the repo root
const MODE = process.argv[2] ?? 'room';
const fs = await import('node:fs');
const { JSDOM, VirtualConsole } = await import('jsdom');

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', err => {
	if (!/Not implemented: navigation|Not implemented: HTMLCanvasElement/.test(err.message)) errors.push(`jsdom: ${err.message}`);
});
const html = fs.readFileSync(`${ROOT}/index.html`, 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'https://peerkit.test/', pretendToBeVisual: true, virtualConsole });
const { window } = dom;
const origError = console.error;
console.error = (...args) => {
	errors.push(args.map(String).join(' '));
	origError(...args);
};
process.on('unhandledRejection', err => errors.push(`unhandled rejection: ${err?.stack ?? err}`));
window.addEventListener('error', e => errors.push(`window error: ${e.message}`));
const warnings = [];
console.warn = (...args) => warnings.push(args.map(String).join(' '));

// Android's "Share → PeerKit" before the app was opened: the real service worker takes the POST and keeps it.
// This runs before the globals below are replaced, because Node builds the shared File with the global File.
const { fakeCaches, loadServiceWorker } = await import('../sw-harness.mjs');
const offline = () => {
	throw new TypeError('Failed to fetch');
};
const { api: cacheApi } = fakeCaches(window.location.href, offline);
globalThis.caches = window.caches = cacheApi;
const worker = loadServiceWorker(`${ROOT}/sw.js`, { scope: window.location.href, caches: cacheApi, fetch: offline });
const shared = new FormData();
shared.append('text', 'from the gallery');
shared.append('files', new File(['shared bytes'], 'holiday.jpg', { type: 'image/jpeg' }));
await worker.request(new Request(`${window.location.href}share-target`, { method: 'POST', body: shared }));

const expose = ['window', 'Window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history',
	'HTMLElement', 'HTMLDialogElement', 'HTMLAnchorElement', 'HTMLInputElement', 'Element', 'Node', 'Text', 'DocumentFragment',
	'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'Range', 'Selection',
	'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'InputEvent', 'FocusEvent', 'CompositionEvent', 'DOMParser', 'File', 'Blob'];
for (const key of expose) Object.defineProperty(globalThis, key, { value: key === 'window' ? window : window[key], configurable: true, writable: true });
// The desktop layout follows one media query; the test widens and narrows the window through it.
const wide = { matches: MODE === 'desktop', listeners: new Set() };
window.matchMedia = globalThis.matchMedia = query => (query.includes('min-width: 900px')
	? { get matches() { return wide.matches; }, addEventListener: (type, fn) => wide.listeners.add(fn), removeEventListener: (type, fn) => wide.listeners.delete(fn) }
	: { matches: false, addEventListener() {}, removeEventListener() {} });
const setWide = on => {
	wide.matches = on;
	for (const fn of [...wide.listeners]) fn({ matches: on });
};
globalThis.ResizeObserver = window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
// jsdom loads no stylesheets; the desktop layout waits for dockview's, so say it arrived.
new window.MutationObserver(records => {
	for (const node of records.flatMap(r => [...r.addedNodes])) if (node.nodeName === 'LINK') setTimeout(() => node.dispatchEvent(new window.Event('load')));
}).observe(window.document.head, { childList: true });
window.confirm = globalThis.confirm = () => true;
window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
window.HTMLDialogElement.prototype.close = function () {
	if (!this.hasAttribute('open')) return;
	this.removeAttribute('open');
	this.dispatchEvent(new window.Event('close'));
};
window.Range.prototype.getClientRects = () => [];
window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
window.HTMLElement.prototype.scrollIntoView ??= () => {};
window.URL.createObjectURL = globalThis.URL.createObjectURL = () => 'blob:fake';
globalThis.QRCode = window.QRCode = class {
	static CorrectLevel = { M: 0 };
	constructor(el, { text }) {
		el.dataset.qr = text;
	}
};
globalThis.RTCPeerConnection = window.RTCPeerConnection = class {};
window.HTMLMediaElement.prototype.play = function () {
	return Promise.resolve();
};
Object.defineProperty(window.navigator, 'mediaDevices', {
	value: {
		async getUserMedia(constraints = {}) {
			return new FakeMediaStream([constraints.video && 'video', constraints.audio && 'audio'].filter(Boolean));
		},
		async enumerateDevices() {
			return [];
		},
	},
	configurable: true,
});
await import('fake-indexeddb/auto');
for (const key of Object.getOwnPropertyNames(window).filter(k => /^(indexedDB|IDB)/.test(k))) {
	Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
const { FakeMediaStream, FakePeer, net } = await import('./fakenet.mjs');
globalThis.Peer = window.Peer = FakePeer;


const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// The Stream tool keeps a stream 30 s for a viewer who dropped; its own timers run 100× faster here.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) =>
	realSetTimeout(fn, ms >= 1000 && /\/app\/tools\/stream\.js/.test(new Error().stack) ? ms / 100 : ms, ...args);
let failures = 0;
function check(name, ok, extra = '') {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
	if (!ok) failures++;
}
async function until(name, fn, ms = 5000) {
	const start = Date.now();
	for (;;) {
		let value;
		try {
			value = fn();
		} catch {
			value = false;
		}
		if (value) return check(name, true, `${Date.now() - start} ms`);
		if (Date.now() - start > ms) return check(name, false, 'timed out');
		await sleep(10);
	}
}
const $ = sel => document.querySelector(sel);
const visible = el => Boolean(el) && !el.closest('[hidden]');
const buttonByText = (root, text) => [...root.querySelectorAll('button')].find(b => b.textContent.trim().includes(text));
const lastDialog = () => [...document.querySelectorAll('dialog[open]')].at(-1);
const stored = () => JSON.parse(localStorage.getItem('peerkit.room') ?? 'null');

const { Room } = await import(`${ROOT}/app/room.js`);
const { newRoomCode } = await import(`${ROOT}/app/rooms.js`);
const { PUBLIC_PROFILE } = await import(`${ROOT}/app/settings.js`);
const { CH } = await import(`${ROOT}/app/protocol.js`);
const { RoomDoc } = await import(`${ROOT}/app/roomdoc.js`);
const { Timeline } = await import(`${ROOT}/app/tools/chat/timeline.js`);
/** The chat of a headless member: its room document, under a storage name of its own. */
async function chatOf(member) {
	const data = new RoomDoc(member, 'b'.repeat(32));
	await data.load();
	return new Timeline(data, member.self);
}

if (MODE === 'start') {
	localStorage.setItem('peerkit.recent', JSON.stringify({ version: 1, hosts: [] }));
	await import(`${ROOT}/app/main.js`);
	await sleep(50);
	check('the start screen shows', visible($('#view-start')) && !visible($('#view-session')) && !visible($('#view-message')));
	check('the top bar has no room status or Leave', $('#status').hidden && $('#leave').hidden);
	check('the notice about the old pairing data shows', visible($('.start-notice')));
	await until('a share that arrived with no room open waits in a banner',
		() => visible($('#banner')) && $('#banner-text').textContent === 'holiday.jpg and text is waiting. Open a room to send it.',
		1000);
	$('#banner-action').click();
	await until('Discard drops it', () => $('#banner').hidden, 1000);
	const input = $('.room-input');
	input.value = 'fox-42';
	$('.join-form').requestSubmit();
	check('an old-style code is refused with an explanation', visible($('.form-error')) && $('.form-error').textContent.includes('4 words'));
	input.value = 'http://x/#join=fox-42&t=abc';
	$('.join-form').requestSubmit();
	check('an old pairing link is refused', $('.form-error').textContent.includes('older PeerKit'));
	input.value = 'ABAN abil ABLE about';
	$('.join-form').requestSubmit();
	check('a typed code with 4-letter prefixes opens that room', stored()?.current === 'abandon-ability-able-about' && stored().rooms[0].known === false);
	check('recent rooms list it', [...document.querySelectorAll('.recent-meta')].some(el => el.textContent.includes('abandon-ability-able-about')));
	buttonByText($('#view-start'), 'New room').click();
	const created = stored();
	check('New room makes a known room current and asks for the invite sheet', created.current !== 'abandon-ability-able-about' && created.rooms[0].known && sessionStorage.getItem('peerkit.invite') === created.current);
	buttonByText($('.recent'), '') ?? null;
	document.querySelector('.recent-item .icon-btn').click();
	await sleep(50);
	check('Forget removes a room from the list', stored().rooms.length === 1);

	// Settings, from the start screen.
	$('#open-settings').click();
	await sleep(50);
	const { APP_VERSION } = await import(`${ROOT}/app/version.js`);
	const { PROTOCOL_VERSION } = await import(`${ROOT}/app/protocol.js`);
	check('Settings shows the app version and the protocol number',
		$('#view-settings .version')?.textContent === `PeerKit ${APP_VERSION} · room protocol ${PROTOCOL_VERSION}`,
		$('#view-settings .version')?.textContent);
} else if (MODE === 'desktop') {
	// A wide window with a mouse: the tools are dockview panels instead of bottom tabs.
	const code = newRoomCode();
	const phone = new Room({ code, ice: { forRoom: null, adopt: () => false }, identity: { id: 'bbbbbbbbbbbbbbbb', name: 'Phone' } });
	phone.start();
	const phoneChat = await chatOf(phone);
	await sleep(100);
	localStorage.setItem('peerkit.room', JSON.stringify({ version: 1, current: code, rooms: [{ code, profile: PUBLIC_PROFILE, names: [], lastSeen: 0, known: true }] }));
	await import(`${ROOT}/app/main.js`);

	const groups = () => [...document.querySelectorAll('.dv-groupview')].map(group => ({
		el: group,
		tools: [...group.querySelectorAll('.dock-tab')].map(tab => tab.textContent),
		front: group.querySelector('.dv-tab.dv-active-tab .dock-tab')?.textContent,
		button: label => [...group.querySelectorAll('.dock-actions button')].find(b => b.title.startsWith(label) && !b.hidden),
	}));
	const groupWith = name => groups().find(group => group.tools.includes(name));
	const tabOf = name => [...document.querySelectorAll('.dock-tab')].find(tab => tab.textContent === name);
	const layout = () => [...groups()].map(group => group.tools.join('+')).sort().join(' | ');
	await until('the room opens with the tools as panels and no bottom tabs', () => $('#tool-host.docked .dock') && $('#tabs').hidden && groups().length === 2, 8000);
	await until('with the member linked', () => $('.member-chip:nth-child(2)')?.textContent === 'Phone');
	check('the default layout: Stream and Editor in the main area, the Chat at the side', layout() === 'Chat | Stream+Editor', layout());
	check('the Editor is in front in the main area', groupWith('Editor').front === 'Editor');
	// The member here runs no editor, so it never answers the sync: past "Loading" is what shows it loaded.
	await until('and loads by itself, since it can be seen', () => /Syncing with the room|Write together/.test($('.editor-message:not([hidden])')?.textContent), 10000);
	check('a tab can not be closed: there is no close button', !document.querySelector('.dock .dv-default-tab-action'));
	check('Reset layout is in the top bar', visible($('#reset-layout')));
	const editorEl = $('[data-tool="editor"]');
	const cm = $('.cm-editor') ?? $('.editor');

	// Maximize the main area: the chat at the side can't be seen, so a message there marks its tab.
	groupWith('Editor').button('Maximize').click();
	check('Maximize turns into Restore', Boolean(groupWith('Editor').button('Restore')));
	phoneChat.addText('hi from the phone');
	await until('a message for a tool out of sight marks its tab', () => tabOf('Chat')?.classList.contains('notify'));
	groupWith('Editor').button('Restore').click();
	await until('and the mark goes when it can be seen again', () => !tabOf('Chat').classList.contains('notify'));

	// A stream that starts brings its panel to the front.
	phone.send(CH.STREAM, { type: 'start', id: 'cam1', kind: 'camera' });
	await until('a stream from a member brings the Stream panel to the front', () => groupWith('Stream').front === 'Stream');

	// Float the chat, then narrow the window: the bottom tabs come back with the same tools, not new ones.
	groupWith('Chat').button('Float').click();
	check('Float takes the chat out of the grid', Boolean(groupWith('Chat').button('Put back')) && !groupWith('Chat').button('Maximize'));
	await until('the layout is saved on this device', () => JSON.parse(localStorage.getItem('peerkit.layout') ?? 'null')?.layout?.floatingGroups?.length === 1, 2000);
	setWide(false);
	check('a narrow window gets the bottom tabs back', !$('#tabs').hidden && !$('.dock') && $('#reset-layout').hidden && !$('#tool-host').classList.contains('docked'));
	check('with the same tool elements, not remounted ones', $('[data-tool="editor"]') === editorEl && ($('.cm-editor') ?? $('.editor')) === cm);
	check('and one tool shown at a time', [...document.querySelectorAll('.tool')].filter(el => !el.hidden).length === 1);
	buttonByText($('#tabs'), 'Chat').click();
	check('the tabs work as on a phone', visible($('[data-tool="chat"] .composer')) && !visible($('[data-tool="editor"]')));

	// Wide again: the saved layout comes back, floating chat and all.
	setWide(true);
	await until('widening brings the panels back as they were', () => groups().length === 2 && Boolean(groupWith('Chat')?.button('Put back')) && groupWith('Stream').front === 'Stream');
	check('and the tool that was in front in the tabs is in front', groupWith('Chat').front === 'Chat');

	// Reset layout: the default again.
	$('#reset-layout').click();
	await until('Reset layout brings back the default', () => layout() === 'Chat | Stream+Editor' && Boolean(groupWith('Chat').button('Float')) && groupWith('Editor').front === 'Editor');
	await until('and saves it', () => {
		const saved = JSON.parse(localStorage.getItem('peerkit.layout'))?.layout;
		return saved && !saved.floatingGroups?.length && Object.keys(saved.panels).length === 3;
	}, 2000);

	// A saved layout that doesn't fit (another app version, or edited by hand) is ignored.
	setWide(false);
	localStorage.setItem('peerkit.layout', JSON.stringify({ version: 1, layout: { panels: { transfer: {}, whiteboard: {} } } }));
	setWide(true);
	await until('a saved layout for other tools falls back to the default', () => layout() === 'Chat | Stream+Editor');
	phone.send(CH.STREAM, { type: 'stop', id: 'cam1' });
	await phone.leave();
} else {
	// A headless member ("Phone") already in the room.
	const code = newRoomCode();
	const phone = new Room({ code, ice: { forRoom: null, adopt: () => false }, identity: { id: 'bbbbbbbbbbbbbbbb', name: 'Phone' } });
	phone.inbox = [];
	phone.on(`msg:${CH.TRANSFER}`, (msg, from) => phone.inbox.push([msg, from]));
	phone.on('binary', data => phone.inbox.push(['binary', data]));
	const voiceHeard = []; // what the member is told about this device's voice, and the calls it gets
	const voiceCalls = [];
	phone.on(`msg:${CH.VOICE}`, msg => voiceHeard.push(msg));
	phone.on('call', call => voiceCalls.push(call));
	phone.start();
	const phoneChat = await chatOf(phone);
	await sleep(100);
	check('the headless member holds the room', phone.state === 'open' && phone.isAnchor);

	localStorage.setItem('peerkit.room', JSON.stringify({ version: 1, current: code, rooms: [{ code, profile: PUBLIC_PROFILE, names: [], lastSeen: 0, known: false }] }));
	sessionStorage.setItem('peerkit.invite', code);
	await import(`${ROOT}/app/main.js`);
	await until('the app joins and shows the room', () => visible($('#view-session')) && $('.member-chip:nth-child(2)')?.textContent === 'Phone');
	check('the top bar says 2 in the room', $('#status-text').textContent === '2 in the room' && !$('#leave').hidden);
	check('the tool tabs show', visible($('#tabs')) && $('#tabs').textContent.includes('Editor'));
	check('the room is now known and remembers who was there', stored().rooms[0].known === true && stored().rooms[0].names.includes('Phone'));
	let dialog = [...document.querySelectorAll('dialog[open]')].find(d => d.querySelector('.room-code'));
	check('the invite sheet opened once for the new room', dialog?.querySelector('.room-code')?.textContent === code && !sessionStorage.getItem('peerkit.invite'));
	check('the invite link and QR carry the code', dialog.querySelector('.link').value.endsWith(`#room=${code}`) && dialog.querySelector('.qr').dataset.qr.endsWith(`#room=${code}`));
	buttonByText(dialog, 'Done').click();

	// The share the worker kept before the app opened: the Chat offers to send it to the room.
	await until('the shared file is offered to the room', () => lastDialog()?.textContent.includes('holiday.jpg'));
	check('with the switch to keep it for the room', lastDialog().textContent.includes('Keep for the room'));
	check('the shared text went into the composer', $('.composer textarea').value === 'from the gallery');
	buttonByText(lastDialog(), 'Send').click();
	await until('sending it reaches the member', () => phone.inbox.some(([m]) => m.type === 'offer' && m.name === 'holiday.jpg'));
	const shareOffer = phone.inbox.find(([m]) => m.type === 'offer' && m.name === 'holiday.jpg')[0];
	phone.send(CH.TRANSFER, { type: 'accept', id: shareOffer.id }, phone.members[0].peerId);
	await until('with the shared bytes', () => phone.inbox.some(([m, data]) => m === 'binary' && data.byteLength === 4 + 12));
	phone.send(CH.TRANSFER, { type: 'complete', id: shareOffer.id }, phone.members[0].peerId);
	$('.composer textarea').value = '';

	// Chat: text both ways, through the room document.
	const app = phone.members[0];
	phoneChat.addText('hi from the phone https://example.com');
	await until('text from a member shows with its name', () => [...document.querySelectorAll('.msg.theirs')].some(m => m.querySelector('.sender')?.textContent === 'Phone' && m.textContent.includes('hi from the phone')));
	$('.composer textarea').value = 'hello room';
	$('.composer').requestSubmit();
	await until('text typed here reaches the member', () => phoneChat.messages().some(m => m.text === 'hello room'));

	// Chat: a file from here to the member.
	const cardOf = name => [...document.querySelectorAll('.msg[data-id]')].find(m => m.querySelector('.file-name')?.textContent === name);
	const fileInput = $('.composer input[type=file]');
	Object.defineProperty(fileInput, 'files', { value: [new File(['hello file'], 'note.txt', { type: 'text/plain' })], configurable: true });
	fileInput.dispatchEvent(new window.Event('change'));
	buttonByText(lastDialog(), 'Send').click();
	await until('the member gets an offer', () => phone.inbox.some(([m]) => m.type === 'offer' && m.name === 'note.txt'));
	const offer = phone.inbox.find(([m]) => m.type === 'offer' && m.name === 'note.txt')[0];
	check('and the file is in the chat', phoneChat.messages().some(m => m.id === offer.file && m.file.name === 'note.txt'));
	phone.send(CH.TRANSFER, { type: 'accept', id: offer.id }, app.peerId);
	await until('the member receives the bytes', () => phone.inbox.some(([m, data]) => m === 'binary' && data.byteLength === 4 + 10));
	phone.send(CH.TRANSFER, { type: 'complete', id: offer.id }, app.peerId);
	await until('the card says delivered', () => cardOf('note.txt')?.querySelector('.file-status').textContent.startsWith('Delivered'));

	// Chat: a file from the member, sent once.
	const sentOnce = phoneChat.addFile({ name: 'photo.bin', size: 3, type: '', keep: false });
	phone.send(CH.TRANSFER, { type: 'offer', id: 7, file: sentOnce.id, name: 'photo.bin', size: 3, mime: '', keep: false, hash: null }, app.peerId);
	await until('an incoming file is accepted', () => phone.inbox.some(([m]) => m.type === 'accept' && m.id === 7));
	const frame = new Uint8Array(7);
	new DataView(frame.buffer).setUint32(0, 7);
	frame.set([1, 2, 3], 4);
	await phone.sendBinary(app.peerId, frame.buffer);
	await until('and received, with Open and Download', () => cardOf('photo.bin')?.dataset.state === 'here' && buttonByText(cardOf('photo.bin'), 'Download') && buttonByText(cardOf('photo.bin'), 'Open'));

	// Voice: its own row in the room bar, reachable from every tool.
	const voiceBar = () => $('.voice-bar');
	const chips = () => [...document.querySelectorAll('.member-chip')];
	check('the room bar offers voice', Boolean(buttonByText(voiceBar(), 'Join voice')) && voiceBar().textContent.includes('Nobody is talking yet'));
	buttonByText(voiceBar(), 'Join voice').click();
	await until('joining voice tells the member', () => voiceHeard.some(m => m.type === 'state' && m.on === true && m.mic === true));
	check('the bar offers Mute and Leave voice', Boolean(buttonByText(voiceBar(), 'Mute')) && Boolean(buttonByText(voiceBar(), 'Leave voice')));
	check('and this device is marked in voice', chips()[0].dataset.voice === 'on');
	buttonByText(voiceBar(), 'Mute').click();
	await until('muting reaches the member', () => voiceHeard.some(m => m.type === 'state' && m.muted === true));
	check('the chip shows it muted', chips()[0].dataset.voice === 'muted');
	buttonByText(voiceBar(), 'Unmute').click();

	// The member joins voice with no microphone, so this device is the side that calls.
	phone.send(CH.VOICE, { type: 'state', on: true, muted: true, mic: false }, app.peerId);
	await until('a member in voice is called', () => voiceCalls.length === 1 && voiceCalls[0].metadata?.kind === 'voice');
	await until('and shows on its chip', () => chips()[1].dataset.voice === 'muted');
	check('the bar counts both', voiceBar().textContent.includes('2 in voice'));
	buttonByText(voiceBar(), 'Leave voice').click();
	await until('leaving tells the member and ends the call', () => voiceCalls[0].closed && voiceHeard.some(m => m.type === 'state' && m.on === false));
	check('this device drops its mark while the member stays in voice', !chips()[0].dataset.voice && chips()[1].dataset.voice === 'muted');

	// Stream: one member, so no picker; buttons enabled.
	buttonByText($('#tabs'), 'Stream').click();
	check('Stream offers sharing to the room', visible(buttonByText($('.stream'), 'Share camera')) && !buttonByText($('.stream'), 'Share camera').disabled);

	// Editor: loads, syncs with a headless provider on the phone.
	const lib = await import(`${ROOT}/vendor/editor.js`);
	const { DocProvider } = await import(`${ROOT}/app/docsync.js`);
	const phoneDoc = new lib.Y.Doc();
	const phoneAwareness = new lib.awarenessProtocol.Awareness(phoneDoc);
	phoneAwareness.setLocalState({ user: { name: 'Phone', color: '#0c8599' }, doc: null });
	new DocProvider({ lib, room: phone, doc: phoneDoc, awareness: phoneAwareness });
	buttonByText($('#tabs'), 'Editor').click();
	await until('the editor loads', () => $('.editor-message:not([hidden])')?.textContent.includes('Write together'), 10000);
	buttonByText($('.editor'), 'New document').click();
	await until('a new document reaches the member', () => [...phoneDoc.getMap('docs').values()].some(entry => entry.get('name') === 'Untitled'));
	const [entry] = [...phoneDoc.getMap('docs').values()];
	entry.get('text').insert(0, 'typed on the phone');
	await until('typing on the member shows here', () => $('.cm-content')?.textContent.includes('typed on the phone'));

	// The member leaves: this device is alone and takes over the anchor.
	await phone.leave();
	await until('the members bar says nobody else is here', () => $('.members-note')?.textContent.includes('Nobody else') && $('#status-text').textContent === 'Only you');
	buttonByText($('#tabs'), 'Chat').click();
	check('the chat says the member left', [...document.querySelectorAll('.sys')].some(el => el.textContent.startsWith('Phone left')));
	await until('this device takes over the anchor', () => window.peerkit.isAnchor, 6000);

	// Sharing with nobody in the room: the capture starts and waits for the first person to arrive.
	buttonByText($('#tabs'), 'Stream').click();
	check('the share buttons work in an empty room', !buttonByText($('.stream'), 'Share camera').disabled);
	buttonByText($('.stream'), 'Share camera').click();
	await until('the camera starts with no viewer', () => $('.stream .live')?.textContent.includes('waiting for someone to join'));
	check('and no picker was shown', !lastDialog());

	const tablet = new Room({ code, ice: { forRoom: null, adopt: () => false }, identity: { id: 'cccccccccccccccc', name: 'Tablet' } });
	const tabletCalls = [];
	tablet.on('call', call => tabletCalls.push(call));
	tablet.start();
	await until('a newcomer gets the stream that was waiting', () => tabletCalls.some(call => call.metadata?.kind === 'camera'), 8000);
	await until('and the bar names the viewer', () => $('.stream .live')?.textContent === 'Sharing camera with Tablet');

	// The viewer goes and is not back within the grace: the capture keeps running for whoever comes next.
	await tablet.leave();
	await until('the viewer leaving pauses the stream for it', () => $('.stream .live')?.textContent === 'Paused until Tablet is back…');
	await until('after the grace it waits for anyone instead of stopping', () => $('.stream .live')?.textContent === 'Tablet left — waiting for someone to join', 3000);
	check('with the capture still on and no "stopped" offer', !$('.stream .preview').hidden && $('.stream-resume').hidden && !buttonByText($('.stream'), 'Share camera'));
	const back = new Room({ code, ice: { forRoom: null, adopt: () => false }, identity: { id: 'cccccccccccccccc', name: 'Tablet' } });
	const backCalls = [];
	back.on('call', call => backCalls.push(call));
	back.start();
	await until('the viewer coming back later gets the stream again', () => backCalls.some(call => call.metadata?.kind === 'camera'), 8000);
	check('the same stream, not a new one', backCalls.find(call => call.metadata?.kind === 'camera').metadata.id === tabletCalls.find(call => call.metadata?.kind === 'camera').metadata.id);
	await until('and the bar names the viewer again', () => $('.stream .live')?.textContent === 'Sharing camera with Tablet');
	buttonByText($('.stream'), 'Stop').click();
	await back.leave();
	await until('stopping leaves the share buttons ready again', () => Boolean(buttonByText($('.stream'), 'Share camera')));

	// Leave.
	$('#leave').click();
	dialog = lastDialog();
	check('Leave asks, with Leave and forget', buttonByText(dialog, 'Leave and forget') && buttonByText(dialog, 'Leave'));
	[...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === 'Leave').click();
	await until('Leave closes the room but keeps it in the list', () => stored().current === null && stored().rooms.length === 1, 3000);
}

await sleep(100);
check('no errors logged', errors.length === 0, errors.slice(0, 3).join(' | '));
const unexpected = warnings.filter(w => !/peer error|IndexedDB/.test(w));
check('no unexpected warnings', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
