import { RoomDoc } from '../../roomdoc.js';
import { button, h, icon, linkify, openDialog, timeLabel, toast } from '../../ui/dom.js';
import { copyText, formatBytes, formatDuration, formatSpeed, randomId, readJSON, writeJSON } from '../../util.js';
import { KeptStore, canKeep, hashFile, keptSettings } from './kept.js';
import { MAX_TEXT, Timeline, cleanFileName, cleanType } from './timeline.js';
import { FINAL, MemorySink, Transfers } from './transfers.js';
import { download, fileKind, mediaType, openViewer } from './viewer.js';

const PREFS_KEY = 'peerkit.chat';
const PREFS_VERSION = 1;
const PAGE = 200; // messages shown at first, and how many more "Show earlier" adds
const UI_INTERVAL = 200;
const PREVIEW_MAX_BYTES = 25 * 1024 * 1024;
const COPY_PART = 4 * 1024 * 1024; // how the sender's own copy of a kept file is read and stored
const MAX_NOTES = 100; // "… joined" and "… left" lines kept on the page

/*
 * The room chat: messages and files in one timeline (timeline.js) that lives in the room document, so it is
 * the same on every device and a newcomer gets the history. Files:
 *   - Send once: to the members online now, held in memory for this page. The others see the entry as "Not kept".
 *   - Keep for the room: the sender and every receiver keep a copy on disk (kept.js); whoever comes later taps
 *     Open or Download and gets it from any member online that has one (transfers.js), checked against its hash.
 * Files open in the viewer (viewer.js) without being saved first.
 */

export default {
	id: 'chat',
	title: 'Chat',
	supported: () => true,
	mount(el, room, ctx) {
		const tool = new ChatTool(el, room, ctx);
		return () => tool.destroy();
	},
};

function loadPrefs() {
	const raw = readJSON(PREFS_KEY);
	return { keep: raw?.version === PREFS_VERSION ? raw.keep !== false : true };
}

function timeText(time) {
	const date = new Date(time);
	const clock = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	if (date.toDateString() === new Date().toDateString()) return clock;
	return `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${clock}`;
}

function sender(msg) {
	return h('div', { class: 'sender', style: `--who: ${msg.color}` }, msg.name);
}

function names(list) {
	const all = [...new Set(list.map(item => item.name))];
	return all.length > 2 ? `${all.slice(0, 2).join(', ')} and ${all.length - 2} more` : all.join(' and ');
}

function averageSpeed(size, { startedAt, endedAt }) {
	if (!startedAt || !endedAt || size < 1024 * 1024) return '';
	return ` · ${formatSpeed((size * 1000) / Math.max(1, endedAt - startedAt))}`;
}

/** Where a kept file goes as it arrives: onto disk, checked against its hash. */
function keptSink(writer) {
	return {
		write: bytes => writer.write(bytes),
		finish: async () => ({ file: (await writer.finish()).file, stored: true }),
		abort: () => writer.abort(),
	};
}

class ChatTool {
	constructor(root, room, ctx) {
		this.room = room;
		this.ctx = ctx;
		this.prefs = loadPrefs();
		this.data = new RoomDoc(room, ctx.room);
		this.timeline = null;
		this.loadError = null;
		this.destroyed = false;
		this.store = canKeep() ? new KeptStore(ctx.room) : null;
		this.local = new Map(); // file id → { file?, stored }: the copy this device has, in memory or kept on disk
		this.dropped = keptSettings.droppedIn(ctx.room); // kept files this device dropped to stay under its limit
		this.nodes = new Map(); // message id → { msg, root, card? } for the messages on the page
		this.previews = new Map(); // file id → object URL of its thumbnail
		this.notes = []; // { node, after }: who joined and left, shown after the message that was last then
		this.pending = []; // files being read (and kept) before they go into the chat
		this.shown = PAGE;
		this.transfers = new Transfers(room, { source: id => this.sourceOf(id), sink: (meta, member) => this.sinkFor(meta, member) });

		this.fileInput = h('input', {
			type: 'file',
			multiple: true,
			hidden: true,
			onchange: () => {
				this.confirmSend([...this.fileInput.files]);
				this.fileInput.value = '';
			},
		});
		this.attachBtn = h('button', { type: 'button', class: 'icon-btn', title: 'Attach files', 'aria-label': 'Attach files', onclick: () => this.fileInput.click() }, icon('attach'));
		this.textarea = h('textarea', {
			rows: 1,
			placeholder: 'Message or link',
			enterkeyhint: 'send',
			'aria-label': 'Message',
			oninput: () => this.autosize(),
			onkeydown: e => this.onKey(e),
			onpaste: e => this.onPaste(e),
		});
		this.sendBtn = h('button', { type: 'submit', class: 'icon-btn primary', title: 'Send', 'aria-label': 'Send' }, icon('send'));
		this.form = h('form', { class: 'composer', onsubmit: e => { e.preventDefault(); this.sendText(); } },
			this.fileInput, this.attachBtn, this.textarea, this.sendBtn);
		this.empty = h('div', { class: 'feed-empty' });
		this.earlier = button('Show earlier messages', null, () => this.showEarlier(), 'btn small ghost feed-earlier');
		this.feed = h('div', { class: 'feed', role: 'log', 'aria-live': 'polite' }, this.empty);
		this.el = h('div', { class: 'chat' }, this.feed, this.form);
		root.append(this.el);

		this.onDragOver = e => {
			if (!e.dataTransfer?.types?.includes('Files')) return;
			e.preventDefault();
			this.el.classList.add('dragging');
		};
		this.onDragLeave = e => {
			if (!e.relatedTarget) this.el.classList.remove('dragging');
		};
		this.onDrop = e => {
			this.el.classList.remove('dragging');
			if (!e.dataTransfer?.files?.length) return;
			e.preventDefault();
			this.confirmSend([...e.dataTransfer.files]);
		};
		document.addEventListener('dragover', this.onDragOver);
		document.addEventListener('dragleave', this.onDragLeave);
		document.addEventListener('drop', this.onDrop);

		this.unsubscribe = [
			room.on('link-up', member => this.addNote(`${member.name} joined`)),
			room.on('link-down', (member, reason) => this.addNote(reason === 'bye' ? `${member.name} left` : `Lost the connection to ${member.name}`)),
			room.on('members', () => this.renderCards()), // who is online decides where a kept file can come from
			this.transfers.on('change', id => this.renderCard(id)),
			this.transfers.on('progress', id => this.renderCard(id, false)),
			this.transfers.on('received', (id, result) => this.onReceived(id, result)),
			keptSettings.on('dropped', (roomId, id) => {
				if (roomId === ctx.room) this.onDropped(id);
			}),
		];
		// Android's "Share → PeerKit": the files and text another app handed over, once the room is open.
		if (ctx.onShare) this.unsubscribe.push(ctx.onShare(share => this.onShared(share)));
		this.render();
		this.load();
	}

	destroy() {
		this.destroyed = true;
		this.unsubscribe.forEach(fn => fn());
		document.removeEventListener('dragover', this.onDragOver);
		document.removeEventListener('dragleave', this.onDragLeave);
		document.removeEventListener('drop', this.onDrop);
		this.transfers.destroy();
		this.data.destroy();
		for (const url of this.previews.values()) URL.revokeObjectURL(url);
		this.el.remove();
	}

	// --- loading ---

	load() {
		this.loadError = null;
		this.render();
		this.data.load()
			.then(() => this.ready())
			.catch(err => {
				console.warn('[peerkit] chat failed to load', err);
				this.loadError = err;
				this.render();
			});
	}

	async ready() {
		if (this.destroyed || !this.data.doc || this.timeline) return;
		this.timeline = new Timeline(this.data, this.room.self);
		this.timeline.on('change', change => this.onChange(change));
		this.timeline.on('held', () => this.renderCards());
		this.timeline.on('removed', ids => this.onRemoved(ids));
		this.render();
		this.renderMessages({ bottom: true });
		await this.reconcile();
	}

	/** Line up the copies kept on this device with the room's list of who keeps what. */
	async reconcile() {
		const timeline = this.timeline;
		if (!this.store) {
			for (const id of timeline.heldHere()) timeline.hold(id, false);
			return;
		}
		let kept;
		try {
			kept = await this.store.list();
		} catch (err) {
			console.warn('[peerkit] kept files unreadable', err);
			return;
		}
		if (this.destroyed) return;
		for (const [id, size] of kept) {
			const msg = timeline.message(id);
			// Removed while this device was away, trimmed out of the history, or an unfinished copy.
			if (msg?.kind !== 'file' || !msg.file.keep || msg.file.size !== size || timeline.removed(id)) {
				await this.store.remove(id);
				continue;
			}
			if (!this.local.has(id)) this.local.set(id, { stored: true });
			timeline.hold(id, true);
		}
		for (const id of timeline.heldHere()) if (!this.local.get(id)?.stored) timeline.hold(id, false);
		this.renderCards();
	}

	// --- the room document changes ---

	onChange({ added, deleted, remote }) {
		for (const msg of deleted) if (msg.kind === 'file') this.forgetFile(msg.id); // trimmed out of the history
		const self = this.room.self.deviceId;
		this.renderMessages({ mine: !remote && added.some(msg => msg.from === self) });
		if (remote && added.some(msg => msg.from !== self)) this.ctx.notify();
	}

	onRemoved(ids) {
		for (const id of ids) {
			if (this.timeline.removed(id)) this.forgetFile(id);
			this.renderCard(id);
		}
	}

	/** This device lets go of a file: it was removed from the room, or trimmed out of the history. */
	forgetFile(id) {
		this.transfers.drop(id);
		const local = this.local.get(id);
		this.local.delete(id);
		if (local?.stored) this.store.remove(id);
		this.timeline?.hold(id, false);
		this.dropPreview(id);
		this.dropped.delete(id);
		keptSettings.clearDropped(this.ctx.room, id);
	}

	/** The storage limit made this device drop its copy of one of this room's files. */
	onDropped(id) {
		if (this.local.get(id)?.stored) this.local.delete(id);
		this.dropped.add(id);
		this.dropPreview(id);
		this.timeline?.hold(id, false);
		this.renderCard(id);
	}

	onReceived(id, { file, stored }) {
		if (this.timeline?.removed(id)) {
			if (stored) this.store.remove(id);
			return;
		}
		this.local.set(id, { file, stored });
		if (stored) {
			this.timeline?.hold(id, true);
			this.dropped.delete(id);
			keptSettings.clearDropped(this.ctx.room, id);
		}
		this.renderCard(id);
	}

	// --- files for the transfers ---

	/** This device's copy of a kept file, to send to a member who asked for it. */
	async sourceOf(id) {
		const msg = this.timeline?.message(id);
		if (msg?.kind !== 'file' || !msg.file.keep || this.timeline.removed(id)) return null;
		const file = this.local.get(id)?.file ?? (this.store ? await this.store.get(id, msg.file.size) : null);
		if (!file) return null;
		const { name, size, type, keep, hash } = msg.file;
		return { file, meta: { name, size, type, keep, hash } };
	}

	/** Where an incoming file goes: kept on disk when it is kept for the room and this device can, else memory. */
	async sinkFor(meta) {
		const msg = this.timeline?.message(meta.file);
		// Once the entry is known, an offer must match it: nobody slips other bytes in under a kept file's name.
		if (msg && (msg.kind !== 'file' || msg.file.size !== meta.size || msg.file.keep !== meta.keep || msg.file.hash !== meta.hash)) {
			throw new Error('the offer differs from the chat entry');
		}
		if (this.timeline?.removed(meta.file)) throw new Error('removed from the room');
		// A copy is already here: a second one would only overwrite it, and a bad one would take the good one with it.
		if (this.local.has(meta.file) || (meta.keep && (await this.store?.get(meta.file, meta.size)))) throw new Error('already here');
		if (meta.keep && this.store) {
			try {
				return keptSink(await this.store.writer(meta.file, { size: meta.size, hash: meta.hash }));
			} catch (err) {
				console.warn('[peerkit] not kept on this device', err);
				if (err.code === 'space') toast(`No space to keep “${meta.name}” on this device`);
			}
		}
		return new MemorySink(mediaType(meta.name, meta.type), meta.hash);
	}

	/** The file itself: the copy here, or one fetched from a member who keeps it. Null when there is none. */
	async fileFor(msg) {
		const local = this.local.get(msg.id);
		if (local?.file) return local.file;
		if (local?.stored) {
			const file = await this.store.get(msg.id, msg.file.size);
			if (file) {
				local.file = file;
				return file;
			}
			this.local.delete(msg.id);
			this.timeline.hold(msg.id, false);
		}
		if (!msg.file.keep) return null;
		const holders = this.onlineHolders(msg.id);
		if (!holders.length) {
			toast('Nobody who keeps it is here right now');
			this.renderCard(msg.id);
			return null;
		}
		try {
			return (await this.transfers.fetch(msg.id, holders)).file;
		} catch (err) {
			if (err.code !== 'cancelled') toast(err.code === 'mismatch' ? 'The copy didn’t match the original' : 'Couldn’t get the file');
			return null;
		}
	}

	onlineHolders(id) {
		const self = this.room.self.deviceId;
		return this.timeline.holders(id)
			.filter(holder => holder.deviceId !== self)
			.map(holder => this.room.members.find(member => member.deviceId === holder.deviceId))
			.filter(Boolean);
	}

	async open(msg) {
		const file = await this.fileFor(msg);
		if (!file || this.destroyed) return;
		openViewer({
			file,
			name: msg.file.name,
			type: msg.file.type,
			onEdit: this.ctx.handOff ? text => this.ctx.handOff('editor', text) : null,
		});
	}

	async save(msg) {
		const file = await this.fileFor(msg);
		if (file) download(file, msg.file.name);
	}

	// --- composer ---

	/** What came from the Android share sheet: text goes into the composer, files into the send sheet. */
	onShared({ text, files }) {
		this.ctx.activate();
		if (text) {
			this.textarea.value = this.textarea.value ? `${this.textarea.value}\n${text}` : text;
			this.autosize();
		}
		if (files.length) this.confirmSend(files);
	}

	onKey(e) {
		// Enter sends on desktop; on touch keyboards Enter inserts a newline and the button sends.
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) {
			e.preventDefault();
			this.form.requestSubmit();
		}
	}

	onPaste(e) {
		const files = [...(e.clipboardData?.files ?? [])];
		if (!files.length) return;
		e.preventDefault();
		this.confirmSend(files);
	}

	autosize() {
		const ta = this.textarea;
		ta.style.height = 'auto';
		ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
	}

	sendText() {
		const text = this.textarea.value;
		if (!text.trim() || !this.timeline) return;
		if (text.length > MAX_TEXT) {
			toast(`Too long for one message (over ${MAX_TEXT.toLocaleString('en')} characters). Send it as a file or open it in the Editor.`);
			return;
		}
		this.timeline.addText(text);
		this.textarea.value = '';
		this.autosize();
	}

	savePrefs(patch) {
		this.prefs = { ...this.prefs, ...patch };
		writeJSON(PREFS_KEY, { version: PREFS_VERSION, ...this.prefs });
	}

	/** Every file goes through this sheet: it says who gets it, and holds the "Keep for the room" switch. */
	confirmSend(files) {
		if (!files.length) return;
		const total = files.reduce((sum, file) => sum + file.size, 0);
		const keep = h('input', { type: 'checkbox', checked: this.prefs.keep, onchange: () => {
			this.savePrefs({ keep: keep.checked });
			update();
		} });
		const note = h('p', { class: 'hint' });
		const send = button('Send', 'send', () => {
			dialog.close();
			this.sendFiles(files, keep.checked);
		}, 'btn primary');
		const update = () => {
			const others = this.room.members.length;
			const people = others === 1 ? 'the 1 person' : `the ${others} people`;
			if (keep.checked) {
				send.disabled = !this.timeline || (!others && !this.store);
				note.textContent = !others
					? this.store ? 'Nobody else is here yet. It stays on this device, and whoever joins later can get it from here.' : 'Nobody else is here yet, and this browser can’t keep files: invite someone first.'
					: `${people[0].toUpperCase()}${people.slice(1)} here now get it and keep a copy, and whoever comes later can get it from them.${this.store ? '' : ' This browser can’t keep a copy itself.'}`;
			} else {
				send.disabled = !this.timeline || !others;
				note.textContent = others
					? `Goes to ${people} here now. Nobody keeps it: it is gone once they close PeerKit.`
					: 'Nobody else is here yet. Keep it for the room, or invite someone first.';
			}
		};
		const dialog = openDialog(h('div', { class: 'sheet-body' },
			h('h2', {}, files.length === 1 ? 'Send this file?' : `Send ${files.length} files?`),
			h('ul', { class: 'share-list' }, files.map(file => h('li', {},
				h('span', { class: 'file-name', title: file.name }, file.name),
				h('span', { class: 'file-size' }, formatBytes(file.size))))),
			files.length > 1 && h('p', { class: 'hint' }, `${formatBytes(total)} in all`),
			h('label', { class: 'check' }, keep, h('span', {}, 'Keep for the room')),
			note,
			h('div', { class: 'actions end' },
				button('Cancel', null, () => dialog.close(), 'btn ghost'),
				send)));
		const off = this.room.on('members', update);
		dialog.addEventListener('close', off);
		update();
		// A share from another app can open this before the chat has loaded.
		if (!this.timeline) this.data.load().then(update, () => {});
	}

	async sendFiles(files, keep) {
		for (const file of files) {
			if (this.destroyed || !this.timeline) return;
			await this.sendFile(file, keep);
		}
	}

	/** Kept: read it once to store this device's copy and hash it, then announce it. Sent once: announce it. */
	async sendFile(file, keep) {
		const id = randomId(8);
		const name = cleanFileName(file.name);
		let hash = null;
		let stored = null;
		const pending = this.addPending(name, file.size, keep);
		try {
			if (keep && this.store) {
				try {
					stored = await this.copyToStore(id, file, pending);
				} catch (err) {
					if (err.code === 'read') throw err;
					toast(err.code === 'space' ? 'No space to keep a copy on this device' : 'Couldn’t keep a copy on this device');
				}
			}
			if (keep) hash = stored?.hash ?? (await hashFile(file, done => pending.progress(done)));
		} catch (err) {
			console.warn('[peerkit] could not read a file to send', err);
			toast(`Could not read “${name}”`);
			return;
		} finally {
			pending.remove();
		}
		if (this.destroyed) return;
		const type = cleanType(file.type);
		this.timeline.addFile({ name, size: file.size, type, keep, hash }, id);
		this.local.set(id, stored ? { file: stored.file, stored: true } : { file, stored: false });
		if (stored) this.timeline.hold(id, true);
		const members = this.room.members;
		if (members.length) this.transfers.push({ file: id, name, size: file.size, type, keep, hash }, file, members);
		this.renderCard(id);
	}

	async copyToStore(id, file, pending) {
		const writer = await this.store.writer(id, { size: file.size });
		try {
			for (let offset = 0; offset < file.size; offset += COPY_PART) {
				let bytes;
				try {
					bytes = new Uint8Array(await file.slice(offset, offset + COPY_PART).arrayBuffer());
				} catch (err) {
					throw Object.assign(err, { code: 'read' });
				}
				writer.write(bytes);
				await writer.settle(); // the disk sets the pace, so a big file never piles up in memory
				pending.progress(offset + bytes.byteLength);
			}
			return await writer.finish();
		} catch (err) {
			await writer.abort();
			throw err;
		}
	}

	// --- rendering ---

	render() {
		const ready = Boolean(this.timeline);
		this.sendBtn.disabled = this.attachBtn.disabled = !ready;
		let content;
		if (this.loadError) {
			content = [
				h('p', {}, 'Could not load the chat.'),
				h('p', { class: 'hint' }, 'Check the internet connection and try again.'),
				button('Try again', null, () => this.load(), 'btn primary'),
			];
		} else if (!ready) {
			content = [h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('p', {}, 'Loading the chat…')];
		} else {
			content = [
				h('p', {}, 'Messages and files for everyone in the room.'),
				h('p', { class: 'hint' }, 'They stay in the room, so people who join later see them too. Attach files with the clip button, or paste or drop them here.'),
			];
		}
		this.empty.replaceChildren(...content);
	}

	addNote(text) {
		if (!this.timeline) return; // the members who were already here when the page opened: the room bar shows them
		const node = h('div', { class: 'sys' }, `${text} · ${timeLabel()}`);
		this.notes.push({ node, after: this.timeline.messages().at(-1)?.id ?? null });
		if (this.notes.length > MAX_NOTES) this.notes.shift().node.remove();
		this.renderMessages();
	}

	addPending(name, size, keep) {
		const bar = h('progress', { max: 1, value: 0 });
		const node = h('div', { class: 'msg mine', 'data-state': 'preparing' },
			h('div', { class: 'bubble file' },
				h('div', { class: 'file-head' }, icon('file'),
					h('div', { class: 'file-title' },
						h('div', { class: 'file-name', title: name }, name),
						h('div', { class: 'file-size' }, formatBytes(size)))),
				keep ? bar : null,
				h('div', { class: 'file-status' }, keep ? 'Getting it ready to keep…' : 'Sending…')));
		const pending = {
			node,
			progress: done => {
				bar.value = size ? done / size : 1;
			},
			remove: () => {
				this.pending = this.pending.filter(other => other !== pending);
				this.renderMessages();
			},
		};
		this.pending.push(pending);
		this.renderMessages({ mine: true });
		return pending;
	}

	showEarlier() {
		const fromBottom = this.feed.scrollHeight - this.feed.scrollTop;
		this.shown += PAGE;
		this.renderMessages();
		this.feed.scrollTop = this.feed.scrollHeight - fromBottom;
	}

	/** Put the newest messages on the page in timeline order, reusing the nodes that are already there. */
	renderMessages({ mine = false, bottom = false } = {}) {
		if (!this.timeline) return;
		const feed = this.feed;
		const nearBottom = bottom || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
		const all = this.timeline.messages();
		const start = Math.max(0, all.length - this.shown);
		const shown = all.slice(start);
		const ids = new Set(shown.map(msg => msg.id));
		for (const [id, node] of this.nodes) {
			if (ids.has(id)) continue;
			node.root.remove();
			this.nodes.delete(id);
			this.dropPreview(id);
		}
		const notesAfter = new Map();
		for (const note of this.notes) {
			if (!notesAfter.has(note.after)) notesAfter.set(note.after, []);
			notesAfter.get(note.after).push(note.node);
		}
		const wanted = [];
		if (start > 0) wanted.push(this.earlier);
		else wanted.push(...(notesAfter.get(null) ?? []));
		for (const msg of shown) wanted.push(this.nodeFor(msg).root, ...(notesAfter.get(msg.id) ?? []));
		wanted.push(...this.pending.map(pending => pending.node));
		if (!wanted.length) wanted.push(this.empty);

		let cursor = feed.firstChild;
		for (const node of wanted) {
			if (node === cursor) cursor = cursor.nextSibling;
			else feed.insertBefore(node, cursor);
		}
		while (cursor) {
			const next = cursor.nextSibling;
			cursor.remove();
			cursor = next;
		}
		if (nearBottom || mine) feed.scrollTop = feed.scrollHeight;
	}

	nodeFor(msg) {
		let node = this.nodes.get(msg.id);
		if (!node) {
			node = msg.kind === 'file' ? this.fileNode(msg) : this.textNode(msg);
			this.nodes.set(msg.id, node);
		}
		return node;
	}

	isMine(msg) {
		return msg.from === this.room.self.deviceId;
	}

	textNode(msg) {
		const mine = this.isMine(msg);
		const copy = h('button', {
			type: 'button',
			class: 'icon-btn small',
			title: 'Copy',
			'aria-label': 'Copy text',
			onclick: async () => toast((await copyText(msg.text)) ? 'Copied' : 'Copy failed'),
		}, icon('copy'));
		const root = h('div', { class: `msg ${mine ? 'mine' : 'theirs'}`, 'data-id': msg.id },
			h('div', { class: 'bubble' },
				!mine && sender(msg),
				h('div', { class: 'text' }, linkify(msg.text)),
				h('div', { class: 'meta' }, h('time', { datetime: new Date(msg.time).toISOString() }, timeText(msg.time)), copy)));
		return { msg, root };
	}

	fileNode(msg) {
		const mine = this.isMine(msg);
		const { file } = msg;
		const card = {
			msg,
			bar: h('progress', { max: 1, value: 0 }),
			status: h('div', { class: 'file-status' }),
			actions: h('div', { class: 'file-actions' }),
			details: h('ul', { class: 'file-recipients', hidden: true }),
			preview: h('div', { class: 'file-preview', hidden: true }),
			remove: h('button', {
				type: 'button',
				class: 'icon-btn small',
				title: 'Remove from room',
				'aria-label': 'Remove from room',
				onclick: () => {
					if (confirm(`Remove “${file.name}” from the room?\n\nEvery device deletes its copy.`)) this.timeline.remove(msg.id);
				},
			}, icon('trash')),
		};
		card.root = h('div', { class: `msg ${mine ? 'mine' : 'theirs'}`, 'data-id': msg.id },
			h('div', { class: 'bubble file' },
				!mine && sender(msg),
				h('div', { class: 'file-head' },
					icon('file'),
					h('div', { class: 'file-title' },
						h('div', { class: 'file-name', title: file.name }, file.name),
						h('div', { class: 'file-size' }, `${formatBytes(file.size)} · ${file.keep ? 'kept for the room' : 'sent once'}`))),
				card.preview,
				card.bar,
				card.details,
				h('div', { class: 'file-foot' }, card.status, card.actions),
				h('div', { class: 'meta' }, h('time', { datetime: new Date(msg.time).toISOString() }, timeText(msg.time)), card.remove)));
		const node = { msg, root: card.root, card };
		this.drawCard(card, true);
		return node;
	}

	renderCards() {
		for (const node of this.nodes.values()) if (node.card) this.drawCard(node.card, true);
	}

	renderCard(id, full = true) {
		const card = this.nodes.get(id)?.card;
		if (card) this.drawCard(card, full);
	}

	/** A file card says where the file is for this device, and what can be done with it from here. */
	drawCard(card, full) {
		const now = performance.now();
		if (!full && now - (card.drawnAt ?? 0) < UI_INTERVAL) return;
		card.drawnAt = now;
		const { msg } = card;
		const { id, file } = msg;
		const removed = this.timeline.removed(id);
		const local = removed ? null : this.local.get(id);
		const { incoming, outgoing, fetching } = this.transfers.status(id);
		const receiving = Boolean(incoming) && (incoming.state === 'receiving' || incoming.state === 'checking');
		const sends = outgoing ? [...outgoing.sends.values()] : [];
		const pushes = sends.filter(send => send.req == null); // the file going out to the room, from its sender
		const sending = sends.some(send => !FINAL.has(send.state));
		for (const send of sends) send.sent = this.transfers.bufferedFor(send);

		let state;
		let status;
		const actions = [];
		const cancel = fn => actions.push(button('Cancel', 'close', fn));
		const openers = () => actions.push(button('Open', null, () => this.open(msg)), button('Download', 'download', () => this.save(msg)));
		if (removed) {
			state = 'removed';
			status = `Removed by ${removed.by}`;
		} else if (receiving) {
			state = 'receiving';
			status = incoming.state === 'checking' ? 'Checking…' : this.progressText(incoming.done, file.size, incoming.meter.rate);
			if (incoming.state === 'receiving') cancel(() => this.transfers.cancelIncoming(id));
		} else if (sending) {
			state = 'sending';
			status = this.outStatus(sends.filter(send => !FINAL.has(send.state) || send.req == null), file.size);
			if (sends.some(send => !FINAL.has(send.state) && send.state !== 'finishing')) cancel(() => this.transfers.cancelOutgoing(id));
		} else if (fetching) {
			state = 'receiving';
			status = 'Asking for it…';
			cancel(() => this.transfers.cancelIncoming(id));
		} else if (local) {
			state = 'here';
			if (pushes.length) status = this.outStatus(pushes, file.size);
			else if (incoming?.state === 'received') status = `Received${averageSpeed(file.size, incoming)}${local.stored ? ' · kept here' : ''}`;
			else status = local.stored ? 'Kept on this device' : this.isMine(msg) ? 'Sent once' : 'Received';
			openers();
			if (local.stored && !local.file && !local.reading) {
				// Kept on disk from an earlier visit: fetch the handle once, for the thumbnail and a quick Open.
				local.reading = true;
				this.store.get(id, file.size).then(copy => {
					if (copy && this.local.get(id) === local) {
						local.file = copy;
						this.renderCard(id);
					}
				});
			}
		} else if (file.keep) {
			const holders = this.timeline.holders(id).filter(holder => holder.deviceId !== this.room.self.deviceId);
			const online = this.onlineHolders(id);
			const lead = [
				incoming?.state === 'failed' && incoming.error,
				this.dropped.has(id) && 'Dropped from this device to free space.',
			].filter(Boolean).join(' ');
			if (online.length) {
				state = 'away';
				status = `${lead ? `${lead} ` : ''}Kept by ${names(online)}`;
				openers();
			} else {
				state = 'unavailable';
				status = `${lead ? `${lead} ` : ''}${holders.length ? `Not available right now — ${names(holders)} ${holders.length === 1 ? 'has' : 'have'} it` : 'Nobody keeps it any more'}`;
			}
		} else {
			state = 'not-kept';
			status = incoming?.state === 'failed' || incoming?.state === 'cancelled-remote' ? 'Interrupted — not kept' : 'Not kept';
		}

		card.root.dataset.state = state;
		card.status.textContent = status;
		card.actions.replaceChildren(...actions);
		card.remove.hidden = Boolean(removed);
		const moving = receiving || sends.some(send => send.state === 'sending' || send.state === 'finishing');
		card.bar.hidden = !moving;
		if (moving) {
			const total = file.size * (receiving ? 1 : sends.length);
			const done = receiving ? incoming.done : sends.reduce((sum, send) => sum + (send.state === 'delivered' ? file.size : send.sent), 0);
			card.bar.value = total ? done / total : 1;
		}
		// With several recipients, each one's progress on its own line.
		card.details.hidden = removed || pushes.length < 2;
		if (!card.details.hidden) {
			card.details.replaceChildren(...pushes.map(send => h('li', {},
				h('span', { class: 'file-recipient-name' }, send.member.name),
				h('span', { class: 'file-recipient-status' }, this.sendStatus(send, file.size)))));
		}
		this.drawPreview(card, local?.file ?? null);
	}

	drawPreview(card, file) {
		const { id, file: info } = card.msg;
		const show = Boolean(file) && fileKind(info.name, info.type) === 'image' && info.size <= PREVIEW_MAX_BYTES;
		if (!show) {
			if (!card.preview.hidden) this.dropPreview(id);
			card.preview.hidden = true;
			return;
		}
		if (this.previews.has(id) && card.preview.firstChild) return;
		const url = URL.createObjectURL(new Blob([file], { type: mediaType(info.name, info.type) }));
		this.previews.set(id, url);
		const img = h('img', { src: url, alt: info.name, onclick: () => this.open(card.msg) });
		img.addEventListener('error', () => {
			card.preview.hidden = true;
		});
		card.preview.replaceChildren(img);
		card.preview.hidden = false;
	}

	dropPreview(id) {
		const url = this.previews.get(id);
		if (!url) return;
		URL.revokeObjectURL(url);
		this.previews.delete(id);
		this.nodes.get(id)?.card?.preview.replaceChildren();
	}

	progressText(done, size, rate) {
		const parts = [`${size ? Math.floor((done / size) * 100) : 100}%`];
		if (rate > 0) parts.push(formatSpeed(rate), `${formatDuration((size - done) / rate)} left`);
		return parts.join(' · ');
	}

	outStatus(sends, size) {
		if (sends.length === 1) return this.sendStatus(sends[0], size);
		const delivered = sends.filter(send => send.state === 'delivered').length;
		const active = sends.filter(send => !FINAL.has(send.state));
		if (active.length) {
			const rate = sends.reduce((sum, send) => sum + (send.state === 'sending' ? send.meter.rate : 0), 0);
			return [`Sending to ${active.length}`, delivered && `${delivered} delivered`, rate > 0 && formatSpeed(rate)].filter(Boolean).join(' · ');
		}
		if (delivered === sends.length) return `Delivered to all ${sends.length}`;
		if (sends.every(send => send.state === 'cancelled')) return 'Cancelled';
		return `Delivered to ${delivered} of ${sends.length}`;
	}

	sendStatus(send, size) {
		switch (send.state) {
			case 'queued':
				return 'Queued';
			case 'offered':
				return 'Waiting…';
			case 'sending':
				return this.progressText(send.sent, size, send.meter.rate);
			case 'finishing':
				return 'Finishing…';
			case 'delivered':
				return `Delivered${send.member.name && send.req != null ? ` to ${send.member.name}` : ''}${averageSpeed(size, send)}`;
			case 'cancelled':
				return 'Cancelled';
			case 'cancelled-remote':
				return `Cancelled by ${send.member.name}`;
			case 'failed':
				return send.error ?? 'Interrupted — connection lost';
		}
		return '';
	}
}
