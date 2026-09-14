import { CH } from '../protocol.js';
import { button, h, icon, linkify, timeLabel, toast } from '../ui/dom.js';
import { copyText, formatBytes, formatDuration, formatSpeed, wakeLock } from '../util.js';

const TEXT_PART_CHARS = 3000; // peerjs JSON messages must stay under ~16 KB
const CONSOLIDATE_BYTES = 16 * 1024 * 1024; // fold chunks into Blobs so the browser can page them out of RAM
const HEADER_BYTES = 4; // u32 transfer id in front of every binary chunk
const UI_INTERVAL = 200;
const PREVIEW_MAX_BYTES = 25 * 1024 * 1024;
const FINAL = new Set(['delivered', 'received', 'cancelled', 'cancelled-remote', 'failed']);

/*
 * Protocol (ch: 'transfer'):
 *   text     {id, part, parts, text}      long text is split into parts
 *   offer    {id, name, size, mime}       sender → receiver
 *   accept   {id}                         receiver → sender; chunks start only after this
 *   complete {id}                         receiver → sender once all bytes arrived
 *   abort    {id, dir}                    dir is the aborting side's view: 'out' = its outgoing transfer
 * Ids are per sending side, so incoming and outgoing maps are separate.
 */

export default {
	id: 'transfer',
	title: 'Transfer',
	supported: () => true,
	mount(el, session, ctx) {
		const tool = new TransferTool(el, session, ctx);
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

class TransferTool {
	constructor(root, session, ctx) {
		this.session = session;
		this.ctx = ctx;
		this.nextId = 1;
		this.outgoing = new Map();
		this.incoming = new Map();
		this.texts = new Map();
		this.queue = [];
		this.pumping = false;
		this.wasConnected = false;

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
		this.sendBtn = h('button', { type: 'submit', class: 'icon-btn primary', title: 'Send', 'aria-label': 'Send' }, icon('send'));
		this.form = h('form', { class: 'composer', onsubmit: e => { e.preventDefault(); this.sendText(); } },
			this.fileInput, this.attachBtn, this.textarea, this.sendBtn);
		this.empty = h('div', { class: 'feed-empty' },
			h('p', {}, 'Send text, links or files to the other device.'),
			h('p', { class: 'hint' }, 'Attach with the clip button, or paste or drop files here.'));
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
			session.onMessage(CH.TRANSFER, msg => this.onMessage(msg)),
			session.on('binary', data => this.onChunk(data)),
			session.on('state', () => this.onState()),
		];
		this.onState();
	}

	destroy() {
		this.unsubscribe.forEach(fn => fn());
		document.removeEventListener('dragover', this.onDragOver);
		document.removeEventListener('dragleave', this.onDragLeave);
		document.removeEventListener('drop', this.onDrop);
		this.interruptAll();
		this.el.remove();
	}

	get connected() {
		return this.session.state === 'connected';
	}

	onState() {
		const connected = this.connected;
		this.sendBtn.disabled = this.attachBtn.disabled = !connected;
		if (connected && !this.wasConnected) this.addSystem(`Connected to ${this.session.remote?.name ?? 'device'}`);
		if (!connected && this.wasConnected) {
			this.addSystem('Disconnected');
			this.interruptAll();
		}
		this.wasConnected = connected;
	}

	// --- composer ---

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

	requireConnection() {
		if (this.connected) return true;
		toast('Not connected');
		return false;
	}

	// --- text ---

	sendText() {
		const text = this.textarea.value;
		if (!text.trim() || !this.requireConnection()) return;
		const id = this.nextId++;
		const parts = Math.ceil(text.length / TEXT_PART_CHARS);
		for (let part = 0; part < parts; part++) {
			const slice = text.slice(part * TEXT_PART_CHARS, (part + 1) * TEXT_PART_CHARS);
			this.session.send(CH.TRANSFER, { type: 'text', id, part, parts, text: slice });
		}
		this.addText(text, 'mine');
		this.textarea.value = '';
		this.autosize();
	}

	onTextPart(msg) {
		const { id, part, parts } = msg;
		if (!Number.isInteger(parts) || parts < 1 || parts > 10000 || !Number.isInteger(part) || part < 0 || part >= parts) return;
		let entry = this.texts.get(id);
		if (!entry || part === 0) this.texts.set(id, (entry = { parts: new Array(parts), count: 0 }));
		if (entry.parts[part] === undefined) {
			entry.parts[part] = String(msg.text ?? '');
			entry.count++;
		}
		if (entry.count === parts) {
			this.texts.delete(id);
			this.addText(entry.parts.join(''), 'theirs');
			this.ctx?.notify();
		}
	}

	addText(text, side) {
		const copy = h('button', {
			type: 'button',
			class: 'icon-btn small',
			title: 'Copy',
			'aria-label': 'Copy text',
			onclick: async () => toast((await copyText(text)) ? 'Copied' : 'Copy failed'),
		}, icon('copy'));
		this.append(h('div', { class: `msg ${side}` },
			h('div', { class: 'bubble' },
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

	onMessage(msg) {
		switch (msg.type) {
			case 'text':
				return this.onTextPart(msg);
			case 'offer':
				return this.onOffer(msg);
			case 'accept':
				return this.outgoing.get(msg.id)?.onAccept?.();
			case 'complete': {
				const item = this.outgoing.get(msg.id);
				if (item && (item.state === 'sending' || item.state === 'finishing')) this.setState(item, 'delivered');
				return;
			}
			case 'abort': {
				const item = (msg.dir === 'out' ? this.incoming : this.outgoing).get(msg.id);
				if (item && !FINAL.has(item.state)) this.stop(item, 'cancelled-remote');
				return;
			}
		}
	}

	// --- outgoing files ---

	sendFiles(files) {
		if (!files.length || !this.requireConnection()) return;
		for (const file of files) {
			const item = {
				dir: 'out',
				id: this.nextId++,
				name: file.name || 'file',
				size: file.size,
				mime: file.type,
				file,
				done: 0,
				state: 'queued',
				meter: new RateMeter(),
			};
			this.outgoing.set(item.id, item);
			this.queue.push(item);
			this.createCard(item);
		}
		this.pump();
	}

	async pump() {
		if (this.pumping) return;
		this.pumping = true;
		try {
			while (this.queue.length) {
				const item = this.queue.shift();
				if (item.state === 'queued') await this.sendFile(item);
			}
		} finally {
			this.pumping = false;
		}
	}

	async sendFile(item) {
		const { session } = this;
		const accepted = new Promise(resolve => {
			item.onAccept = () => resolve(true);
			item.onStop = () => resolve(false);
		});
		this.setState(item, 'offered');
		session.send(CH.TRANSFER, { type: 'offer', id: item.id, name: item.name, size: item.size, mime: item.mime });
		if (!(await accepted) || item.state !== 'offered') return;

		this.setState(item, 'sending');
		this.lock(item);
		try {
			const chunkSize = session.maxMessageSize - HEADER_BYTES;
			let offset = 0;
			while (offset < item.size) {
				// Read one slice at a time: the file is never fully loaded into memory.
				const buf = await item.file.slice(offset, offset + chunkSize).arrayBuffer();
				if (item.state !== 'sending') return;
				const frame = new Uint8Array(HEADER_BYTES + buf.byteLength);
				new DataView(frame.buffer).setUint32(0, item.id);
				frame.set(new Uint8Array(buf), HEADER_BYTES);
				await session.sendBinary(frame);
				if (item.state !== 'sending') return;
				offset += buf.byteLength;
				item.done = offset;
				this.progress(item);
			}
			if (item.state === 'sending') this.setState(item, 'finishing');
		} catch (err) {
			if (item.state !== 'sending') return;
			const readError = err instanceof DOMException && err.name !== 'NetworkError' ? err : null;
			if (readError && this.connected) {
				item.error = 'Could not read the file';
				session.send(CH.TRANSFER, { type: 'abort', id: item.id, dir: 'out' });
			}
			this.stop(item, 'failed');
		} finally {
			this.unlock(item);
		}
	}

	// --- incoming files ---

	onOffer(msg) {
		const size = Number(msg.size);
		if (!Number.isInteger(msg.id) || msg.id < 0 || msg.id > 0xffffffff || !Number.isSafeInteger(size) || size < 0) return;
		const previous = this.incoming.get(msg.id);
		if (previous && !FINAL.has(previous.state)) this.stop(previous, 'failed');

		const item = {
			dir: 'in',
			id: msg.id,
			name: String(msg.name || 'file').slice(0, 255),
			size,
			mime: typeof msg.mime === 'string' ? msg.mime : '',
			done: 0,
			state: 'receiving',
			parts: [],
			partsBytes: 0,
			blobs: [],
			meter: new RateMeter(),
		};
		this.incoming.set(item.id, item);
		this.createCard(item);
		this.ctx?.notify();
		this.session.send(CH.TRANSFER, { type: 'accept', id: item.id });
		if (size === 0) this.finishIncoming(item);
		else this.lock(item);
	}

	onChunk(data) {
		if (!(data instanceof ArrayBuffer) || data.byteLength < HEADER_BYTES) return;
		const item = this.incoming.get(new DataView(data).getUint32(0));
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
		else this.progress(item);
	}

	finishIncoming(item) {
		item.blob = new Blob([...item.blobs, ...item.parts], { type: item.mime || 'application/octet-stream' });
		item.blobs = item.parts = null;
		this.unlock(item);
		this.setState(item, 'received');
		this.session.send(CH.TRANSFER, { type: 'complete', id: item.id });
	}

	// --- lifecycle ---

	cancel(item) {
		if (FINAL.has(item.state)) return;
		const notify = item.dir === 'in' || item.state !== 'queued';
		this.stop(item, 'cancelled');
		if (notify && this.connected) this.session.send(CH.TRANSFER, { type: 'abort', id: item.id, dir: item.dir });
	}

	stop(item, state) {
		this.setState(item, state);
		this.unlock(item);
		item.onStop?.();
		if (item.dir === 'in') item.parts = item.blobs = null;
	}

	interruptAll() {
		for (const item of [...this.outgoing.values(), ...this.incoming.values()]) {
			if (!FINAL.has(item.state)) this.stop(item, 'failed');
		}
		this.queue = [];
		this.texts.clear();
	}

	lock(item) {
		if (item.locked) return;
		item.locked = true;
		wakeLock.acquire();
	}

	unlock(item) {
		if (!item.locked) return;
		item.locked = false;
		wakeLock.release();
	}

	// --- rendering ---

	createCard(item) {
		const card = (item.card = {
			bar: h('progress', { max: 1, value: 0 }),
			status: h('div', { class: 'file-status' }),
			actions: h('div', { class: 'file-actions' }),
			preview: h('div', { class: 'file-preview', hidden: true }),
		});
		card.root = h('div', { class: `msg ${item.dir === 'out' ? 'mine' : 'theirs'}` },
			h('div', { class: 'bubble file' },
				h('div', { class: 'file-head' },
					icon('file'),
					h('div', { class: 'file-title' },
						h('div', { class: 'file-name', title: item.name }, item.name),
						h('div', { class: 'file-size' }, formatBytes(item.size)))),
				card.preview,
				card.bar,
				h('div', { class: 'file-foot' }, card.status, card.actions)));
		this.append(card.root);
		this.renderCard(item);
	}

	setState(item, state) {
		item.state = state;
		if (state === 'sending' || state === 'receiving') item.startedAt = performance.now();
		if (state === 'delivered' || state === 'received') item.endedAt = performance.now();
		this.renderCard(item);
	}

	renderCard(item) {
		const { card, state } = item;
		card.root.dataset.state = state;
		card.bar.hidden = !['sending', 'receiving', 'finishing'].includes(state);
		card.actions.replaceChildren();
		if (!FINAL.has(state) && state !== 'finishing') {
			card.actions.append(button('Cancel', 'close', () => this.cancel(item)));
		}
		if (state === 'received') this.renderReceived(item);
		this.progress(item, true);
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
		// Bytes still in the channel buffer haven't left this device yet.
		const sent = item.dir === 'out' ? Math.max(0, item.done - this.session.bufferedAmount) : item.done;
		if (item.state === 'sending' || item.state === 'receiving') item.meter.add(sent);
		if (!force && now - (item.uiAt ?? 0) < UI_INTERVAL) return;
		item.uiAt = now;
		item.card.bar.value = item.size ? sent / item.size : 1;
		item.card.status.textContent = this.statusText(item, sent);
	}

	statusText(item, sent) {
		switch (item.state) {
			case 'queued':
				return 'Queued';
			case 'offered':
				return 'Waiting for the other device…';
			case 'sending':
			case 'receiving': {
				const parts = [`${item.size ? Math.floor((sent / item.size) * 100) : 100}%`];
				const rate = item.meter.rate;
				if (rate > 0) parts.push(formatSpeed(rate), `${formatDuration((item.size - sent) / rate)} left`);
				return parts.join(' · ');
			}
			case 'finishing':
				return 'Finishing…';
			case 'delivered':
				return `Delivered${this.averageSpeed(item)}`;
			case 'received':
				return `Received${this.averageSpeed(item)}`;
			case 'cancelled':
				return 'Cancelled';
			case 'cancelled-remote':
				return item.dir === 'out' ? 'Cancelled by the other device' : 'Cancelled by the sender';
			case 'failed':
				return item.error ?? 'Interrupted — connection lost';
		}
		return '';
	}

	averageSpeed(item) {
		if (!item.startedAt || !item.endedAt || item.size < 1024 * 1024) return '';
		return ` · ${formatSpeed((item.size * 1000) / Math.max(1, item.endedAt - item.startedAt))}`;
	}
}
