import { CH } from '../protocol.js';
import { button, h, icon, linkify, openDialog, timeLabel, toast } from '../ui/dom.js';
import { copyText, formatBytes, formatDuration, formatSpeed, wakeLock } from '../util.js';

const TEXT_PART_CHARS = 3000; // peerjs JSON messages must stay under ~16 KB
const CONSOLIDATE_BYTES = 16 * 1024 * 1024; // fold chunks into Blobs so the browser can page them out of RAM
const HEADER_BYTES = 4; // u32 transfer id in front of every binary chunk
const UI_INTERVAL = 200;
const PREVIEW_MAX_BYTES = 25 * 1024 * 1024;
const FINAL = new Set(['delivered', 'received', 'cancelled', 'cancelled-remote', 'failed']);

/*
 * Protocol (ch: 'transfer'). Text goes to every member; a file goes to each member separately, over the
 * link with that member, so each has its own offer, progress and outcome.
 *   text     {id, part, parts, text}      long text is split into parts
 *   offer    {id, name, size, mime}       sender → receiver
 *   accept   {id}                         receiver → sender; chunks start only after this
 *   complete {id}                         receiver → sender once all bytes arrived
 *   abort    {id, dir}                    dir is the aborting side's view: 'out' = its outgoing transfer
 * Ids are per sending device, so incoming items are keyed by sender and id.
 */

export default {
	id: 'transfer',
	title: 'Transfer',
	supported: () => true,
	mount(el, room, ctx) {
		const tool = new TransferTool(el, room, ctx);
		return () => tool.destroy();
	},
};

class RateMeter {
	samples = [];

	add(bytes) {
		const now = performance.now();
		this.samples.push([now, bytes]);
		while (this.samples.length > 2 && now - this.samples[0][0] > 3000) this.samples.shift();
	}

	get rate() {
		if (this.samples.length < 2) return 0;
		const [t0, b0] = this.samples[0];
		const [t1, b1] = this.samples[this.samples.length - 1];
		return t1 > t0 ? ((b1 - b0) * 1000) / (t1 - t0) : 0;
	}
}

const inKey = (peerId, id) => `${peerId}:${id}`;

class TransferTool {
	constructor(root, room, ctx) {
		this.room = room;
		this.ctx = ctx;
		this.nextId = 1;
		this.outgoing = new Map(); // id → { id, name, size, mime, file, sends: Map(peerId → send), card }
		this.incoming = new Map(); // `${peerId}:${id}` → item
		this.texts = new Map();
		this.queues = new Map(); // peerId → { sends: [], pumping }

		this.fileInput = h('input', {
			type: 'file',
			multiple: true,
			hidden: true,
			onchange: () => {
				this.sendFiles([...this.fileInput.files]);
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
		this.sendBtn = h('button', { type: 'submit', class: 'icon-btn primary', title: 'Send to everyone', 'aria-label': 'Send to everyone' }, icon('send'));
		this.form = h('form', { class: 'composer', onsubmit: e => { e.preventDefault(); this.sendText(); } },
			this.fileInput, this.attachBtn, this.textarea, this.sendBtn);
		this.empty = h('div', { class: 'feed-empty' },
			h('p', {}, 'Send text, links or files to everyone in the room.'),
			h('p', { class: 'hint' }, 'Attach with the clip button, or paste or drop files here. Only members who are here now receive them.'));
		this.feed = h('div', { class: 'feed', role: 'log', 'aria-live': 'polite' }, this.empty);
		this.el = h('div', { class: 'transfer' }, this.feed, this.form);
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
			this.sendFiles([...e.dataTransfer.files]);
		};
		document.addEventListener('dragover', this.onDragOver);
		document.addEventListener('dragleave', this.onDragLeave);
		document.addEventListener('drop', this.onDrop);

		this.unsubscribe = [
			room.on(`msg:${CH.TRANSFER}`, (msg, member) => this.onMessage(msg, member)),
			room.on('binary', (data, member) => this.onChunk(data, member)),
			room.on('link-up', member => this.addSystem(`${member.name} joined`)),
			room.on('link-down', (member, reason) => this.onLinkDown(member, reason)),
			room.on('members', () => this.renderComposer()),
		];
		// Android's "Share → PeerKit": the files and text another app handed over, once the room is open.
		if (ctx?.onShare) this.unsubscribe.push(ctx.onShare(share => this.onShared(share)));
		this.renderComposer();
	}

	destroy() {
		this.unsubscribe.forEach(fn => fn());
		document.removeEventListener('dragover', this.onDragOver);
		document.removeEventListener('dragleave', this.onDragLeave);
		document.removeEventListener('drop', this.onDrop);
		for (const item of this.outgoing.values()) for (const send of item.sends.values()) this.stopSend(item, send, 'failed');
		for (const item of this.incoming.values()) if (!FINAL.has(item.state)) this.stop(item, 'failed');
		this.el.remove();
	}

	renderComposer() {
		const empty = this.room.members.length === 0;
		this.sendBtn.disabled = this.attachBtn.disabled = empty;
		this.textarea.placeholder = empty ? 'Nobody else is here yet' : 'Message or link';
	}

	onLinkDown(member, reason) {
		this.addSystem(reason === 'bye' ? `${member.name} left` : `Lost the connection to ${member.name}`);
		for (const item of this.outgoing.values()) {
			const send = item.sends.get(member.peerId);
			if (send && !FINAL.has(send.state)) this.stopSend(item, send, 'failed');
		}
		for (const item of this.incoming.values()) {
			if (item.from.peerId === member.peerId && !FINAL.has(item.state)) this.stop(item, 'failed');
		}
		for (const key of [...this.texts.keys()]) if (key.startsWith(`${member.peerId}:`)) this.texts.delete(key);
		this.queues.delete(member.peerId);
	}

	// --- composer ---

	/** What came from the Android share sheet: text goes into the composer, files are sent after a confirmation. */
	onShared({ text, files }) {
		this.ctx?.activate();
		if (text) {
			this.textarea.value = this.textarea.value ? `${this.textarea.value}\n${text}` : text;
			this.autosize();
		}
		if (files.length) this.confirmShare(files);
	}

	confirmShare(files) {
		const total = files.reduce((sum, file) => sum + file.size, 0);
		const note = h('p', { class: 'hint' });
		const send = button('Send', 'send', () => {
			dialog.close();
			this.sendFiles(files);
		}, 'btn primary');
		const update = () => {
			const others = this.room.members.length;
			send.disabled = !others;
			note.textContent = others
				? `Goes to everyone in the room now (${others}).`
				: 'Nobody else is here yet. Invite someone, then send.';
		};
		const dialog = openDialog(h('div', { class: 'sheet-body' },
			h('h2', {}, files.length === 1 ? 'Send this file?' : `Send ${files.length} files?`),
			h('ul', { class: 'share-list' }, files.map(file => h('li', {},
				h('span', { class: 'file-name', title: file.name }, file.name),
				h('span', { class: 'file-size' }, formatBytes(file.size))))),
			files.length > 1 && h('p', { class: 'hint' }, `${formatBytes(total)} in all`),
			note,
			h('div', { class: 'actions end' },
				button('Cancel', null, () => dialog.close(), 'btn ghost'),
				send)));
		const off = this.room.on('members', update);
		dialog.addEventListener('close', off);
		update();
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
		this.sendFiles(files);
	}

	autosize() {
		const ta = this.textarea;
		ta.style.height = 'auto';
		ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
	}

	requireMembers() {
		if (this.room.members.length) return true;
		toast('Nobody else is in the room');
		return false;
	}

	// --- text ---

	sendText() {
		const text = this.textarea.value;
		if (!text.trim() || !this.requireMembers()) return;
		const id = this.nextId++;
		const parts = Math.ceil(text.length / TEXT_PART_CHARS);
		for (let part = 0; part < parts; part++) {
			const slice = text.slice(part * TEXT_PART_CHARS, (part + 1) * TEXT_PART_CHARS);
			this.room.send(CH.TRANSFER, { type: 'text', id, part, parts, text: slice });
		}
		this.addText(text, 'mine');
		this.textarea.value = '';
		this.autosize();
	}

	onTextPart(msg, member) {
		const { id, part, parts } = msg;
		if (!Number.isInteger(parts) || parts < 1 || parts > 10000 || !Number.isInteger(part) || part < 0 || part >= parts) return;
		const key = inKey(member.peerId, id);
		let entry = this.texts.get(key);
		if (!entry || part === 0) this.texts.set(key, (entry = { parts: new Array(parts), count: 0 }));
		if (entry.parts[part] === undefined) {
			entry.parts[part] = String(msg.text ?? '');
			entry.count++;
		}
		if (entry.count === parts) {
			this.texts.delete(key);
			this.addText(entry.parts.join(''), 'theirs', member);
			this.ctx?.notify();
		}
	}

	addText(text, side, from = null) {
		const copy = h('button', {
			type: 'button',
			class: 'icon-btn small',
			title: 'Copy',
			'aria-label': 'Copy text',
			onclick: async () => toast((await copyText(text)) ? 'Copied' : 'Copy failed'),
		}, icon('copy'));
		this.append(h('div', { class: `msg ${side}` },
			h('div', { class: 'bubble' },
				from && sender(from),
				h('div', { class: 'text' }, linkify(text)),
				h('div', { class: 'meta' }, h('time', {}, timeLabel()), copy))));
	}

	addSystem(text) {
		this.append(h('div', { class: 'sys' }, `${text} · ${timeLabel()}`));
	}

	append(node) {
		const feed = this.feed;
		const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
		this.empty.remove();
		feed.append(node);
		if (nearBottom || node.classList.contains('mine')) feed.scrollTop = feed.scrollHeight;
	}

	// --- messages ---

	onMessage(msg, member) {
		switch (msg.type) {
			case 'text':
				return this.onTextPart(msg, member);
			case 'offer':
				return this.onOffer(msg, member);
			case 'accept':
				return this.outgoing.get(msg.id)?.sends.get(member.peerId)?.onAccept?.();
			case 'complete': {
				const item = this.outgoing.get(msg.id);
				const send = item?.sends.get(member.peerId);
				if (send && (send.state === 'sending' || send.state === 'finishing')) this.setSendState(item, send, 'delivered');
				return;
			}
			case 'abort': {
				if (msg.dir === 'out') {
					const item = this.incoming.get(inKey(member.peerId, msg.id));
					if (item && !FINAL.has(item.state)) this.stop(item, 'cancelled-remote');
				} else {
					const item = this.outgoing.get(msg.id);
					const send = item?.sends.get(member.peerId);
					if (send && !FINAL.has(send.state)) this.stopSend(item, send, 'cancelled-remote');
				}
			}
		}
	}

	// --- outgoing files: one send per member ---

	sendFiles(files) {
		if (!files.length || !this.requireMembers()) return;
		const members = this.room.members;
		for (const file of files) {
			const item = { id: this.nextId++, name: file.name || 'file', size: file.size, mime: file.type, file, sends: new Map() };
			for (const member of members) {
				item.sends.set(member.peerId, { member, state: 'queued', done: 0, meter: new RateMeter(), locked: false });
			}
			this.outgoing.set(item.id, item);
			this.createOutCard(item);
			for (const send of item.sends.values()) this.queueFor(send.member.peerId).sends.push([item, send]);
		}
		for (const member of members) this.pump(member.peerId);
	}

	queueFor(peerId) {
		if (!this.queues.has(peerId)) this.queues.set(peerId, { sends: [], pumping: false });
		return this.queues.get(peerId);
	}

	/** One file at a time per member; members are served in parallel over their own links. */
	async pump(peerId) {
		const queue = this.queueFor(peerId);
		if (queue.pumping) return;
		queue.pumping = true;
		try {
			while (queue.sends.length) {
				const [item, send] = queue.sends.shift();
				if (send.state === 'queued') await this.sendFile(item, send);
			}
		} finally {
			queue.pumping = false;
		}
	}

	async sendFile(item, send) {
		const { room } = this;
		const to = send.member.peerId;
		const accepted = new Promise(resolve => {
			send.onAccept = () => resolve(true);
			send.onStop = () => resolve(false);
		});
		this.setSendState(item, send, 'offered');
		if (!room.send(CH.TRANSFER, { type: 'offer', id: item.id, name: item.name, size: item.size, mime: item.mime }, to)) {
			this.stopSend(item, send, 'failed');
			return;
		}
		if (!(await accepted) || send.state !== 'offered') return;

		this.setSendState(item, send, 'sending');
		this.lock(send);
		try {
			const chunkSize = room.maxMessageSize(to) - HEADER_BYTES;
			let offset = 0;
			while (offset < item.size) {
				// Read one slice at a time: the file is never fully loaded into memory.
				const buf = await item.file.slice(offset, offset + chunkSize).arrayBuffer();
				if (send.state !== 'sending') return;
				const frame = new Uint8Array(HEADER_BYTES + buf.byteLength);
				new DataView(frame.buffer).setUint32(0, item.id);
				frame.set(new Uint8Array(buf), HEADER_BYTES);
				await room.sendBinary(to, frame);
				if (send.state !== 'sending') return;
				offset += buf.byteLength;
				send.done = offset;
				this.progress(item);
			}
			if (send.state === 'sending') this.setSendState(item, send, 'finishing');
		} catch (err) {
			if (send.state !== 'sending') return;
			const readError = err instanceof DOMException && err.name !== 'NetworkError' ? err : null;
			if (readError) {
				item.error = 'Could not read the file';
				room.send(CH.TRANSFER, { type: 'abort', id: item.id, dir: 'out' }, to);
			}
			this.stopSend(item, send, 'failed');
		} finally {
			this.unlock(send);
		}
	}

	cancelOutgoing(item) {
		for (const send of item.sends.values()) {
			if (FINAL.has(send.state)) continue;
			const notify = send.state !== 'queued';
			this.stopSend(item, send, 'cancelled');
			if (notify) this.room.send(CH.TRANSFER, { type: 'abort', id: item.id, dir: 'out' }, send.member.peerId);
		}
	}

	stopSend(item, send, state) {
		this.setSendState(item, send, state);
		this.unlock(send);
		send.onStop?.();
	}

	setSendState(item, send, state) {
		send.state = state;
		if (state === 'sending') send.startedAt = performance.now();
		if (state === 'delivered') send.endedAt = performance.now();
		this.renderOutCard(item);
	}

	// --- incoming files ---

	onOffer(msg, member) {
		const size = Number(msg.size);
		if (!Number.isInteger(msg.id) || msg.id < 0 || msg.id > 0xffffffff || !Number.isSafeInteger(size) || size < 0) return;
		const key = inKey(member.peerId, msg.id);
		const previous = this.incoming.get(key);
		if (previous && !FINAL.has(previous.state)) this.stop(previous, 'failed');

		const item = {
			key,
			id: msg.id,
			from: member,
			name: String(msg.name || 'file').slice(0, 255),
			size,
			mime: typeof msg.mime === 'string' ? msg.mime : '',
			done: 0,
			state: 'receiving',
			parts: [],
			partsBytes: 0,
			blobs: [],
			meter: new RateMeter(),
			locked: false,
		};
		this.incoming.set(key, item);
		this.createInCard(item);
		this.ctx?.notify();
		this.room.send(CH.TRANSFER, { type: 'accept', id: item.id }, member.peerId);
		if (size === 0) this.finishIncoming(item);
		else this.lock(item);
	}

	onChunk(data, member) {
		if (!(data instanceof ArrayBuffer) || data.byteLength < HEADER_BYTES) return;
		const item = this.incoming.get(inKey(member.peerId, new DataView(data).getUint32(0)));
		if (!item || item.state !== 'receiving') return;
		const bytes = new Uint8Array(data, HEADER_BYTES);
		item.parts.push(bytes);
		item.partsBytes += bytes.byteLength;
		item.done += bytes.byteLength;
		if (item.partsBytes >= CONSOLIDATE_BYTES) {
			item.blobs.push(new Blob(item.parts));
			item.parts = [];
			item.partsBytes = 0;
		}
		if (item.done >= item.size) this.finishIncoming(item);
		else this.progressIn(item);
	}

	finishIncoming(item) {
		item.blob = new Blob([...item.blobs, ...item.parts], { type: item.mime || 'application/octet-stream' });
		item.blobs = item.parts = null;
		this.unlock(item);
		this.setState(item, 'received');
		this.room.send(CH.TRANSFER, { type: 'complete', id: item.id }, item.from.peerId);
	}

	cancelIncoming(item) {
		if (FINAL.has(item.state)) return;
		this.stop(item, 'cancelled');
		this.room.send(CH.TRANSFER, { type: 'abort', id: item.id, dir: 'in' }, item.from.peerId);
	}

	stop(item, state) {
		this.setState(item, state);
		this.unlock(item);
		item.parts = item.blobs = null;
	}

	setState(item, state) {
		item.state = state;
		if (state === 'receiving') item.startedAt = performance.now();
		if (state === 'received') item.endedAt = performance.now();
		this.renderInCard(item);
	}

	lock(holder) {
		if (holder.locked) return;
		holder.locked = true;
		wakeLock.acquire();
	}

	unlock(holder) {
		if (!holder.locked) return;
		holder.locked = false;
		wakeLock.release();
	}

	// --- rendering ---

	baseCard(item, side, from = null) {
		const card = {
			bar: h('progress', { max: 1, value: 0 }),
			status: h('div', { class: 'file-status' }),
			actions: h('div', { class: 'file-actions' }),
			details: h('ul', { class: 'file-recipients', hidden: true }),
			preview: h('div', { class: 'file-preview', hidden: true }),
		};
		card.root = h('div', { class: `msg ${side}` },
			h('div', { class: 'bubble file' },
				from && sender(from),
				h('div', { class: 'file-head' },
					icon('file'),
					h('div', { class: 'file-title' },
						h('div', { class: 'file-name', title: item.name }, item.name),
						h('div', { class: 'file-size' }, formatBytes(item.size)))),
				card.preview,
				card.bar,
				card.details,
				h('div', { class: 'file-foot' }, card.status, card.actions)));
		return card;
	}

	createOutCard(item) {
		item.card = this.baseCard(item, 'mine');
		this.append(item.card.root);
		this.renderOutCard(item);
	}

	createInCard(item) {
		item.card = this.baseCard(item, 'theirs', item.from);
		this.append(item.card.root);
		this.renderInCard(item);
	}

	renderOutCard(item) {
		const { card } = item;
		const sends = [...item.sends.values()];
		const active = sends.filter(send => !FINAL.has(send.state));
		card.root.dataset.state = active.length ? 'sending' : sends.some(send => send.state === 'delivered') ? 'delivered' : 'failed';
		card.bar.hidden = !sends.some(send => send.state === 'sending' || send.state === 'finishing');
		card.actions.replaceChildren();
		if (active.some(send => send.state !== 'finishing')) card.actions.append(button('Cancel', 'close', () => this.cancelOutgoing(item)));
		// With several recipients, each one's progress on its own line.
		card.details.hidden = sends.length < 2;
		if (sends.length > 1) {
			card.details.replaceChildren(...sends.map(send => {
				send.line ??= h('span', { class: 'file-recipient-status' });
				return h('li', {}, h('span', { class: 'file-recipient-name' }, send.member.name), send.line);
			}));
		}
		this.progress(item, true);
	}

	renderInCard(item) {
		const { card, state } = item;
		card.root.dataset.state = state;
		card.bar.hidden = state !== 'receiving';
		card.actions.replaceChildren();
		if (!FINAL.has(state)) card.actions.append(button('Cancel', 'close', () => this.cancelIncoming(item)));
		if (state === 'received') this.renderReceived(item);
		this.progressIn(item, true);
	}

	renderReceived(item) {
		const { card } = item;
		const url = (item.url ??= URL.createObjectURL(item.blob));
		card.actions.append(h('a', { class: 'btn small', href: url, download: item.name }, icon('download'), 'Download'));
		const file = new File([item.blob], item.name, { type: item.blob.type });
		if (navigator.canShare?.({ files: [file] })) {
			card.actions.append(button('Share', 'share', () => navigator.share({ files: [file], title: item.name }).catch(() => {})));
		}
		if (item.mime.startsWith('image/') && item.size <= PREVIEW_MAX_BYTES) {
			card.preview.replaceChildren(h('img', { src: url, alt: item.name }));
			card.preview.hidden = false;
		}
	}

	progress(item, force = false) {
		const now = performance.now();
		const sends = [...item.sends.values()];
		for (const send of sends) {
			// Bytes still in the channel buffer haven't left this device yet.
			send.sent = Math.max(0, send.done - this.room.bufferedAmount(send.member.peerId));
			if (send.state === 'sending') send.meter.add(send.sent);
		}
		if (!force && now - (item.uiAt ?? 0) < UI_INTERVAL) return;
		item.uiAt = now;
		const total = item.size * sends.length;
		const sent = sends.reduce((sum, send) => sum + (send.state === 'delivered' ? item.size : send.sent), 0);
		item.card.bar.value = total ? sent / total : 1;
		item.card.status.textContent = this.outStatus(item, sends);
		if (sends.length > 1) for (const send of sends) send.line.textContent = this.sendStatus(item, send);
	}

	outStatus(item, sends) {
		if (sends.length === 1) return this.sendStatus(item, sends[0]);
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

	sendStatus(item, send) {
		switch (send.state) {
			case 'queued':
				return 'Queued';
			case 'offered':
				return 'Waiting…';
			case 'sending': {
				const parts = [`${item.size ? Math.floor((send.sent / item.size) * 100) : 100}%`];
				const rate = send.meter.rate;
				if (rate > 0) parts.push(formatSpeed(rate), `${formatDuration((item.size - send.sent) / rate)} left`);
				return parts.join(' · ');
			}
			case 'finishing':
				return 'Finishing…';
			case 'delivered':
				return `Delivered${averageSpeed(item.size, send)}`;
			case 'cancelled':
				return 'Cancelled';
			case 'cancelled-remote':
				return `Cancelled by ${send.member.name}`;
			case 'failed':
				return item.error ?? 'Interrupted — connection lost';
		}
		return '';
	}

	progressIn(item, force = false) {
		const now = performance.now();
		if (item.state === 'receiving') item.meter.add(item.done);
		if (!force && now - (item.uiAt ?? 0) < UI_INTERVAL) return;
		item.uiAt = now;
		item.card.bar.value = item.size ? item.done / item.size : 1;
		item.card.status.textContent = this.inStatus(item);
	}

	inStatus(item) {
		switch (item.state) {
			case 'receiving': {
				const parts = [`${item.size ? Math.floor((item.done / item.size) * 100) : 100}%`];
				const rate = item.meter.rate;
				if (rate > 0) parts.push(formatSpeed(rate), `${formatDuration((item.size - item.done) / rate)} left`);
				return parts.join(' · ');
			}
			case 'received':
				return `Received${averageSpeed(item.size, item)}`;
			case 'cancelled':
				return 'Cancelled';
			case 'cancelled-remote':
				return 'Cancelled by the sender';
			case 'failed':
				return 'Interrupted — connection lost';
		}
		return '';
	}
}

function sender(member) {
	return h('div', { class: 'sender', style: `--who: ${member.color}` }, member.name);
}

function averageSpeed(size, { startedAt, endedAt }) {
	if (!startedAt || !endedAt || size < 1024 * 1024) return '';
	return ` · ${formatSpeed((size * 1000) / Math.max(1, endedAt - startedAt))}`;
}
