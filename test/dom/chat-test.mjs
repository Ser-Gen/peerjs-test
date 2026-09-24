// The Chat tool in jsdom, on the fake peerjs network, with real rooms: the history a newcomer gets, a file sent
// once, files kept for the room and fetched later from whoever keeps them, the viewer, a forged copy, removing
// a file, the storage limit, a long history, and trimming.
const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, ''); // the repo root
const { JSDOM, VirtualConsole } = await import('jsdom');

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', err => {
	if (!/Not implemented: navigation|Not implemented: HTMLMediaElement/.test(err.message)) errors.push(`jsdom: ${err.message}`);
});
const dom = new JSDOM('<!doctype html><html><body><div class="app"></div><div id="toasts"></div></body></html>', {
	url: 'https://peerkit.test/',
	pretendToBeVisual: true,
	virtualConsole,
});
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

const expose = ['window', 'Window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'history',
	'HTMLElement', 'HTMLDialogElement', 'HTMLAnchorElement', 'HTMLInputElement', 'Element', 'Node', 'Text', 'DocumentFragment',
	'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'Range', 'Selection',
	'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'InputEvent', 'FocusEvent', 'CompositionEvent', 'DOMParser', 'File', 'Blob'];
for (const key of expose) Object.defineProperty(globalThis, key, { value: key === 'window' ? window : window[key], configurable: true, writable: true });
window.matchMedia = globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
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
// Object URLs: remembered with the type they were made with, which is what decides how a browser would open them.
const objectUrls = new Map();
let urlCount = 0;
window.URL.createObjectURL = globalThis.URL.createObjectURL = blob => {
	const url = `blob:https://peerkit.test/${++urlCount}`;
	objectUrls.set(url, blob.type);
	return url;
};
window.URL.revokeObjectURL = globalThis.URL.revokeObjectURL = url => objectUrls.delete(url);
const downloads = [];
window.HTMLAnchorElement.prototype.click = function () {
	if (this.hasAttribute('download')) downloads.push({ name: this.getAttribute('download'), type: objectUrls.get(this.href) });
};
window.HTMLMediaElement.prototype.canPlayType = type => (/^video\/(mp4|webm)$/.test(type) ? 'maybe' : '');
window.HTMLMediaElement.prototype.pause = () => {};
Object.defineProperty(window.navigator, 'pdfViewerEnabled', { value: true, configurable: true }); // a desktop browser
await import('fake-indexeddb/auto');
for (const key of Object.getOwnPropertyNames(window).filter(k => /^(indexedDB|IDB)/.test(k))) {
	Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
const { installFakeOpfs } = await import('./fakeopfs.mjs');
const opfs = installFakeOpfs(window.navigator);
const { FakePeer } = await import('./fakenet.mjs');
globalThis.Peer = window.Peer = FakePeer;

const { Room } = await import(`${ROOT}/app/room.js`);
const { newRoomCode } = await import(`${ROOT}/app/rooms.js`);
const { CH } = await import(`${ROOT}/app/protocol.js`);
const { RoomDoc } = await import(`${ROOT}/app/roomdoc.js`);
const { default: chat } = await import(`${ROOT}/app/tools/chat/chat.js`);
const { Timeline } = await import(`${ROOT}/app/tools/chat/timeline.js`);
const { deleteRoomFiles, hashFile, keptSettings, keptUsage } = await import(`${ROOT}/app/tools/chat/kept.js`);
const editorLib = await import(`${ROOT}/vendor/editor.js`);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let failures = 0;
function check(name, ok, extra = '') {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
	if (!ok) failures++;
}
async function until(name, fn, ms = 5000, show = () => '') {
	const start = Date.now();
	for (;;) {
		let value;
		try {
			value = fn();
		} catch {
			value = false;
		}
		if (value) return check(name, true, `${Date.now() - start} ms`);
		if (Date.now() - start > ms) return check(name, false, `timed out ${show()}`);
		await sleep(10);
	}
}
const buttonByText = (root, text) => [...root.querySelectorAll('button')].find(b => b.textContent.trim() === text);
const lastDialog = () => [...document.querySelectorAll('dialog[open]')].at(-1);

// --- devices: a room each, and the Chat mounted in a section of its own ---

const code = newRoomCode();
const ice = () => ({ forRoom: null, adopt: () => false });

function device(name, letter) {
	const id = letter.repeat(16);
	const root = document.createElement('section');
	document.querySelector('.app').append(root);
	// Its own storage key, so the devices in this one "browser" don't share a database or a folder.
	const ctx = {
		room: letter.repeat(32),
		notified: 0,
		handed: [],
		activate() {},
		notify() {
			ctx.notified++;
		},
		visible: () => true,
		onShow: () => () => {},
		handOff(to, file) {
			ctx.handed.push([to, file]);
			return true;
		},
	};
	const room = new Room({ code, ice: ice(), identity: { id, name } });
	room.start();
	const dev = { name, id, root, ctx, room };
	dev.unmount = chat.mount(root, room, ctx);
	return dev;
}

const peerIn = (room, dev) => room.members.find(member => member.deviceId === dev.id)?.peerId;
const loaded = dev => !dev.root.querySelector('.composer button[type=submit]').disabled;
const cardOf = (dev, name) => [...dev.root.querySelectorAll('.msg[data-id]')].find(msg => msg.querySelector('.file-name')?.textContent === name);
const stateOf = (dev, name) => cardOf(dev, name)?.dataset.state;
const statusOf = (dev, name) => cardOf(dev, name)?.querySelector('.file-status')?.textContent ?? '';
const texts = dev => [...dev.root.querySelectorAll('.msg .text')].map(el => el.textContent);
const clickCard = (dev, name, label) => buttonByText(cardOf(dev, name), label).click();
async function kept(dev) {
	try {
		const dir = await (await opfs.getDirectoryHandle('peerkit-kept')).getDirectoryHandle(dev.ctx.room);
		return [...dir.children.keys()];
	} catch {
		return [];
	}
}
const idOf = (dev, name) => cardOf(dev, name)?.dataset.id;
/** The whole history on the page, not only its newest part. */
function showAll(dev) {
	for (let button; (button = dev.root.querySelector('.feed-earlier'));) button.click();
}

function say(dev, text) {
	dev.root.querySelector('.composer textarea').value = text;
	dev.root.querySelector('.composer').requestSubmit();
}

/** Pick files, set the "Keep for the room" switch in the sheet and send. */
function sendFiles(dev, files, keep) {
	const input = dev.root.querySelector('.composer input[type=file]');
	Object.defineProperty(input, 'files', { value: files, configurable: true });
	input.dispatchEvent(new window.Event('change'));
	const sheet = lastDialog();
	const box = sheet.querySelector('input[type=checkbox]');
	if (box.checked !== keep) {
		box.checked = keep;
		box.dispatchEvent(new window.Event('change'));
	}
	const send = buttonByText(sheet, 'Send');
	const enabled = !send.disabled;
	send.click();
	return { sheet, enabled };
}

async function viewer() {
	await until('the viewer opens', () => lastDialog()?.querySelector('.viewer'));
	return lastDialog();
}

const A = device('Laptop', 'a');
await sleep(60); // A holds the room before the others look for it
const B = device('Phone', 'b');
await until('two devices share a room, and both chats load', () => A.room.members.length === 1 && B.room.members.length === 1 && loaded(A) && loaded(B), 8000);

// --- messages, and the history a newcomer gets ---

say(B, 'hello from before');
await until('a message reaches the other device', () => texts(A).includes('hello from before'));
check('with the sender’s name, and on the sender’s own side as mine', A.root.querySelector('.msg.theirs .sender')?.textContent === 'Phone' && B.root.querySelector('.msg.mine .text')?.textContent === 'hello from before');
check('the tab of the device that got it is marked', A.ctx.notified > 0 && B.ctx.notified === 0);

// A photo sent once: to whoever is here, in memory.
const photo = new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], 'photo.png', { type: 'image/png' });
let sent = sendFiles(A, [photo], false);
check('the send sheet has the Keep switch, and says who gets it', sent.enabled && sent.sheet.textContent.includes('Keep for the room') && sent.sheet.textContent.includes('Goes to the 1 person here now'));
await until('a photo sent once arrives', () => stateOf(B, 'photo.png') === 'here' && statusOf(B, 'photo.png').startsWith('Received'), 5000,
	() => `A: ${stateOf(A, 'photo.png')} "${statusOf(A, 'photo.png')}", B: ${stateOf(B, 'photo.png')} "${statusOf(B, 'photo.png')}"`);
check('with a thumbnail', Boolean(cardOf(B, 'photo.png').querySelector('.file-preview:not([hidden]) img')));
clickCard(B, 'photo.png', 'Open');
let view = await viewer();
const shown = view.querySelector('.viewer-body img');
check('Open shows it in the viewer, as an image with a type chosen here', shown && objectUrls.get(shown.src) === 'image/png');
buttonByText(view, 'Download').click();
check('Download saves it as bytes that no browser opens as a page', downloads.at(-1)?.name === 'photo.png' && downloads.at(-1)?.type === 'application/octet-stream');
view.close();
check('closing the viewer lets go of its object URL', !objectUrls.has(shown.src));

const C = device('Tablet', 'c');
await until('a newcomer gets the history', () => loaded(C) && texts(C).includes('hello from before'), 8000);
await until('and sees the photo sent once as not kept', () => stateOf(C, 'photo.png') === 'not-kept' && statusOf(C, 'photo.png') === 'Not kept');
check('with nothing to open', !buttonByText(cardOf(C, 'photo.png'), 'Open'));

// --- kept for the room ---

const clipBytes = new Uint8Array(3000).map((_, i) => (i * 7) % 256);
const clip = new File([clipBytes], 'clip.mp4', { type: 'video/mp4' });
sent = sendFiles(A, [clip], true);
check('the sheet explains keeping', sent.sheet.textContent.includes('get it and keep a copy'));
await until('a kept file arrives on both others', () => stateOf(B, 'clip.mp4') === 'here' && stateOf(C, 'clip.mp4') === 'here');
const clipId = idOf(B, 'clip.mp4');
check('each keeps a copy on disk, the sender too', (await kept(A)).includes(clipId) && (await kept(B)).includes(clipId) && (await kept(C)).includes(clipId));
await until('and each card says so', () => statusOf(B, 'clip.mp4').includes('kept here') && statusOf(A, 'clip.mp4').startsWith('Delivered to all 2'), 2000, () => `${statusOf(A, 'clip.mp4')} / ${statusOf(B, 'clip.mp4')}`);

const codeFile = new File(['const answer = 42;\n// the room\n'], 'code.js', { type: 'text/javascript' });
sendFiles(B, [codeFile], true);
await until('another kept file, from another member', () => stateOf(A, 'code.js') === 'here' && stateOf(C, 'code.js') === 'here');

// The sender leaves: its copy goes with it, and the others still have theirs.
A.unmount();
await A.room.leave();
const D = device('Desk', 'd');
await until('a newcomer after the sender left', () => loaded(D) && D.room.members.length === 2 && stateOf(D, 'clip.mp4') === 'away', 8000, () => `${stateOf(D, 'clip.mp4')} ${statusOf(D, 'clip.mp4')}`);
check('is told who online keeps it', ['Kept by Phone and Tablet', 'Kept by Tablet and Phone'].includes(statusOf(D, 'clip.mp4')), statusOf(D, 'clip.mp4'));
clickCard(D, 'clip.mp4', 'Open');
view = await viewer();
const video = view.querySelector('.viewer-body video');
check('Open fetches it from a member who keeps it, and plays it', video && objectUrls.get(video.src) === 'video/mp4');
view.close();
check('the copy it got is checked and kept here too', stateOf(D, 'clip.mp4') === 'here' && (await kept(D)).includes(clipId));
const clipHash = await hashFile(clip);
const stored = await (await (await (await opfs.getDirectoryHandle('peerkit-kept')).getDirectoryHandle(D.ctx.room)).getFileHandle(clipId)).getFile();
check('byte for byte', (await hashFile(stored)) === clipHash && stored.size === clip.size);
check('the member it came from still says it keeps its own copy', [B, C].every(dev => statusOf(dev, 'clip.mp4').includes('kept here')), `${statusOf(B, 'clip.mp4')} / ${statusOf(C, 'clip.mp4')}`);

// --- the viewer: code, HTML, PDF ---

clickCard(D, 'code.js', 'Open');
view = await viewer();
await until('code opens as text with syntax colours', () => view.querySelector('.viewer-code .cm-content')?.textContent.includes('const answer = 42;') && view.querySelector('.viewer-code .cm-content span[class]'));
check('read only', editorLib.EditorView.findFromDOM(view.querySelector('.cm-editor'))?.state.readOnly === true);
buttonByText(view, 'Open as shared document').click();
check('Open as shared document hands it to the Editor', D.ctx.handed.at(-1)?.[0] === 'editor' && D.ctx.handed.at(-1)[1].name === 'code.js' && !lastDialog());

const page = new File(['<h1>hi</h1><script>window.pwned = true</script>'], 'page.html', { type: 'text/html' });
sendFiles(C, [page], true);
await until('an HTML file arrives', () => stateOf(D, 'page.html') === 'here');
clickCard(D, 'page.html', 'Open');
view = await viewer();
await until('HTML shows as its source, never as a page', () => view.querySelector('.cm-content')?.textContent.includes('<script>window.pwned = true</script>'));
check('no frame, and nothing ran', !view.querySelector('iframe') && window.pwned === undefined);
view.close();

const pdf = new File(['%PDF-1.4\n%%EOF\n'], 'doc.pdf', { type: 'application/pdf' });
sendFiles(C, [pdf], false);
await until('a PDF arrives', () => stateOf(D, 'doc.pdf') === 'here');
clickCard(D, 'doc.pdf', 'Open');
view = await viewer();
const frame = view.querySelector('.viewer-body iframe');
check('a PDF opens in the browser’s own viewer on desktop', frame && objectUrls.get(frame.src) === 'application/pdf');
view.close();

// --- a forged copy, and a long history, from a member without the Chat ---

const mallory = new Room({ code, ice: ice(), identity: { id: 'eeeeeeeeeeeeeeee', name: 'Mallory' } });
mallory.start();
const malloryDoc = new RoomDoc(mallory, 'e'.repeat(32));
await malloryDoc.load();
await until('a member without the Chat syncs the room document', () => mallory.members.length === 3 && malloryDoc.synced, 8000);
const E = device('Spare', 'f');
await until('one more newcomer', () => loaded(E) && E.room.members.length === 4 && stateOf(E, 'clip.mp4') === 'away', 8000);
check('sees three members keeping the file, the one who fetched it too', statusOf(E, 'clip.mp4').endsWith('and 1 more'), statusOf(E, 'clip.mp4'));
const accepted = new Promise(resolve => mallory.on(`msg:${CH.TRANSFER}`, msg => msg.type === 'accept' && msg.id === 99 && resolve()));
mallory.send(CH.TRANSFER, { type: 'offer', id: 99, file: clipId, name: 'clip.mp4', size: clip.size, mime: 'video/mp4', keep: true, hash: clipHash }, peerIn(mallory, E));
await accepted;
const forged = new Uint8Array(4 + clip.size).fill(65);
new DataView(forged.buffer).setUint32(0, 99);
await mallory.sendBinary(peerIn(mallory, E), forged);
await until('a copy that doesn’t match the hash is not kept', () => statusOf(E, 'clip.mp4').startsWith('The copy didn’t match the original'), 5000, () => statusOf(E, 'clip.mp4'));
check('nothing of it stays on disk', !(await kept(E)).includes(clipId));
const offerAgain = () => mallory.send(CH.TRANSFER, { type: 'offer', id: 100, file: clipId, name: 'clip.mp4', size: clip.size, mime: 'video/mp4', keep: true, hash: clipHash }, peerIn(mallory, D));
const refused = new Promise(resolve => mallory.on(`msg:${CH.TRANSFER}`, msg => msg.type === 'abort' && msg.id === 100 && resolve(true)));
offerAgain();
check('and a device that has a good copy refuses another one', await Promise.race([refused, sleep(1000).then(() => false)]));

const flood = new Timeline(malloryDoc, mallory.self);
for (let i = 1; i <= 250; i++) flood.addText(`line ${i}`);
await until('a long history shows its newest part', () => texts(E).includes('line 250') && E.root.querySelector('.feed-earlier'), 5000);
check('200 messages at first', E.root.querySelectorAll('.msg[data-id]').length === 200);
E.root.querySelector('.feed-earlier').click();
check('Show earlier brings the rest', texts(E).includes('hello from before') && !E.root.querySelector('.feed-earlier') && E.root.querySelectorAll('.msg[data-id]').length > 250);

// --- Remove from room ---

[B, C, D, E].forEach(showAll);
cardOf(B, 'clip.mp4').querySelector('[aria-label="Remove from room"]').click();
await until('a removed file is marked removed on every device', () => [B, C, D, E].every(dev => stateOf(dev, 'clip.mp4') === 'removed'));
check('by whom', statusOf(D, 'clip.mp4') === 'Removed by Phone');
await sleep(100);
check('every copy is deleted', !(await kept(B)).includes(clipId) && !(await kept(C)).includes(clipId) && !(await kept(D)).includes(clipId));
check('with nothing left to open', ![B, C, D].some(dev => buttonByText(cardOf(dev, 'clip.mp4'), 'Open')));

// --- the storage limit ---

// The others leave; their folders are other devices' disks, so they go from this shared one too.
for (const dev of [C, D, E]) {
	dev.unmount();
	await dev.room.leave();
	await deleteRoomFiles(dev.ctx.room);
}
await deleteRoomFiles(A.ctx.room); // it left long ago, with its copies
await mallory.leave();
malloryDoc.destroy();
await until('alone in the room', () => B.room.members.length === 0, 5000);
const codeId = idOf(B, 'code.js');
check('it still keeps what it kept', (await kept(B)).includes(codeId));
const big = new File([new Uint8Array(500).fill(7)], 'big.bin');
keptSettings.limit = (await keptUsage()).bytes + big.size - 1; // one file too many
sent = sendFiles(B, [big], true);
check('keeping works alone: whoever joins later gets it from here', sent.enabled && sent.sheet.textContent.includes('whoever joins later can get it from here'));
await until('a new kept file fits under the limit', () => stateOf(B, 'big.bin') === 'here');
await until('because the oldest kept file was dropped, and the timeline says so', () => statusOf(B, 'code.js').startsWith('Dropped from this device to free space.'), 3000, () => statusOf(B, 'code.js'));
check('naming who still has it', statusOf(B, 'code.js').includes('Not available right now') && statusOf(B, 'code.js').includes('Tablet'), statusOf(B, 'code.js'));
check('it is gone from disk', !(await kept(B)).includes(codeId) && (await kept(B)).length === 2);

B.unmount();
await B.room.leave();

// --- trimming: every device drops the same oldest messages ---

const lib = await import(`${ROOT}/vendor/yjs.js`);
const fakeRoomDoc = () => {
	const doc = new lib.Y.Doc();
	return { doc, destroyed: false, isRemote: origin => origin === 'remote' };
};
const one = fakeRoomDoc();
const two = fakeRoomDoc();
one.doc.on('update', (update, origin) => origin !== 'remote' && lib.Y.applyUpdate(two.doc, update, 'remote'));
two.doc.on('update', (update, origin) => origin !== 'remote' && lib.Y.applyUpdate(one.doc, update, 'remote'));
const t1 = new Timeline(one, { deviceId: '1111111111111111', name: 'One' });
const t2 = new Timeline(two, { deviceId: '2222222222222222', name: 'Two' });
const old = t1.addFile({ name: 'old.txt', size: 3, type: 'text/plain', keep: true, hash: 'a'.repeat(64) });
t2.hold(old.id, true);
for (let i = 0; i < 9; i++) t2.addText(`m${i}`);
t1.trim(5);
check('trimming keeps the newest messages, the same on both', t1.messages().length === 5 && t2.messages().map(m => m.text).join() === 'm4,m5,m6,m7,m8');
check('and forgets who kept the files that went', t2.holders(old.id).length === 0);
check('messages from members are checked: a bad one is skipped', (t1.chat.push([{ id: 'x', kind: 'text', text: 'no id' }]), t2.messages().length === 5));

await sleep(200);
check('no errors logged', errors.length === 0, errors.slice(0, 3).join(' | '));
const unexpected = warnings.filter(w => !/peer error|incoming file not kept|not kept on this device|no place for an incoming file/.test(w));
check('no unexpected warnings', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
