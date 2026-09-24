import { button, h, icon, openDialog, toast } from '../../ui/dom.js';
import { codeTheme, darkScheme, extensionOf, highlighting, langOf, languageSupport } from '../../ui/code.js';
import { formatBytes } from '../../util.js';

const MAX_TEXT_BYTES = 5 * 1024 * 1024; // what the viewer shows as text, and the Editor opens
const MAX_PDF_BYTES = 200 * 1024 * 1024; // pdf.js reads the whole file into memory

/*
 * The file viewer, opened from the chat. Nothing is saved to disk to look at a file, and nothing a member
 * sent ever runs: HTML is shown as source and SVG only through <img>, where scripts don't run. Every object
 * URL is made here with a type chosen here, never the sender's, so no link can open a received file as a page.
 */

const IMAGE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml' };
const VIDEO = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg', mkv: 'video/x-matroska' };
const AUDIO = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', weba: 'audio/webm' };
const TEXT = new Set(['txt', 'text', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx',
	'css', 'html', 'htm', 'xml', 'py', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env', 'c', 'h', 'cpp', 'hpp',
	'cc', 'java', 'kt', 'go', 'rs', 'rb', 'php', 'sql', 'swift', 'lua', 'pl', 'r', 'diff', 'patch', 'srt', 'vtt', 'tex', 'bat', 'ps1']);
const MEDIA_TYPE = /^(image|video|audio)\/[\w.+-]+$/;

/** What a file is, from its name first and the sender's type second: image, video, audio, pdf, text or other. */
export function fileKind(name, type = '') {
	const ext = extensionOf(name);
	if (IMAGE[ext]) return 'image';
	if (VIDEO[ext]) return 'video';
	if (AUDIO[ext]) return 'audio';
	if (ext === 'pdf') return 'pdf';
	if (TEXT.has(ext)) return 'text';
	if (ext) return 'other';
	if (type === 'application/pdf') return 'pdf';
	const top = type.split('/')[0];
	if (['image', 'video', 'audio'].includes(top) && MEDIA_TYPE.test(type)) return top;
	if (top === 'text' || type === 'application/json') return 'text';
	return 'other';
}

/** The type an element gets for a file of this kind: from the name, or a media type the sender gave. */
export function mediaType(name, type = '') {
	const ext = extensionOf(name);
	return IMAGE[ext] ?? VIDEO[ext] ?? AUDIO[ext] ?? (ext === 'pdf' ? 'application/pdf' : MEDIA_TYPE.test(type) ? type : 'application/octet-stream');
}

/** A download that saves the file and can never be opened as a page from this site. */
export function download(file, name) {
	const url = URL.createObjectURL(new Blob([file], { type: 'application/octet-stream' }));
	const link = h('a', { href: url, download: name, hidden: true });
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export async function share(file, name, type) {
	try {
		await navigator.share({ files: [new File([file], name, { type: mediaType(name, type) })], title: name });
	} catch (err) {
		if (err?.name !== 'AbortError') toast('Sharing failed');
	}
}

export const canShareFiles = () => Boolean(navigator.canShare?.({ files: [new File([''], 'x.txt', { type: 'text/plain' })] }));

/**
 * Show a file full screen. `file` is a Blob (in memory, or a kept copy on disk); `onEdit(file)` opens text as a
 * shared document in the Editor. Returns the dialog.
 */
export function openViewer({ file, name, type = '', onEdit = null }) {
	const urls = [];
	const cleanups = [];
	const urlFor = kindType => {
		const url = URL.createObjectURL(new Blob([file], { type: kindType }));
		urls.push(url);
		return url;
	};
	const body = h('div', { class: 'viewer-body' });
	const tools = h('div', { class: 'viewer-tools' },
		button('Download', 'download', () => download(file, name), 'btn small'),
		canShareFiles() ? button('Share', 'share', () => share(file, name, type), 'btn small') : null);
	const dialog = openDialog(h('div', { class: 'viewer' },
		h('header', { class: 'viewer-head' },
			h('div', { class: 'viewer-title' },
				h('div', { class: 'file-name', title: name }, name),
				h('div', { class: 'file-size' }, formatBytes(file.size))),
			tools,
			h('button', { type: 'button', class: 'icon-btn', title: 'Close', 'aria-label': 'Close', onclick: () => dialog.close() }, icon('close'))),
		body));
	dialog.classList.add('viewer-sheet');
	dialog.addEventListener('close', () => {
		cleanups.forEach(fn => fn());
		urls.forEach(url => URL.revokeObjectURL(url));
	});

	const notice = (text, hint = 'Download it to open it with another app.') => body.replaceChildren(h('div', { class: 'viewer-note' },
		icon('file'), h('p', {}, text), hint && h('p', { class: 'hint' }, hint)));

	const kind = fileKind(name, type);
	body.dataset.kind = kind;
	if (kind === 'image') {
		const img = h('img', { src: urlFor(mediaType(name, type)), alt: name });
		img.addEventListener('error', () => notice('This image can’t be shown here.'));
		body.replaceChildren(img);
	} else if (kind === 'video' || kind === 'audio') {
		const media = h(kind, { controls: true, playsinline: true, preload: 'metadata' });
		const playType = mediaType(name, type);
		if (!media.canPlayType(playType)) {
			notice(`This browser can’t play ${extensionOf(name).toUpperCase() || 'this'} ${kind === 'video' ? 'videos' : 'audio'}.`);
		} else {
			media.src = urlFor(playType);
			media.addEventListener('error', () => notice(`This ${kind === 'video' ? 'video' : 'audio file'} can’t be played here.`));
			cleanups.push(() => media.pause());
			body.replaceChildren(media);
		}
	} else if (kind === 'pdf') {
		showPdf({ file, name, body, urlFor, cleanups, notice });
	} else if (kind === 'text') {
		showText({ file, name, body, cleanups, notice, tools, onEdit: onEdit && (() => {
			dialog.close();
			onEdit(new File([file], name, { type: 'text/plain' }));
		}) });
	} else {
		notice('There is no preview for this kind of file.');
	}
	return dialog;
}

function spinner(text) {
	return h('div', { class: 'viewer-note' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('p', {}, text));
}

/** Desktop browsers have a PDF viewer of their own; Android Chrome doesn't, so there it is pdf.js (vendor/pdf.js). */
function showPdf({ file, name, body, urlFor, cleanups, notice }) {
	if (navigator.pdfViewerEnabled) {
		body.replaceChildren(h('iframe', { src: urlFor('application/pdf'), title: name }));
		return;
	}
	if (file.size > MAX_PDF_BYTES) return notice(`This PDF is too large to show here (over ${formatBytes(MAX_PDF_BYTES)}).`);
	body.replaceChildren(spinner('Opening the PDF…'));
	let closed = false;
	let task = null;
	cleanups.push(() => {
		closed = true;
		task?.destroy(); // the document, its worker and everything it holds
	});
	(async () => {
		const pdfjs = await import('../../../vendor/pdf.js');
		pdfjs.GlobalWorkerOptions.workerSrc = new URL('../../../vendor/pdf.worker.js', import.meta.url).href;
		const data = new Uint8Array(await file.arrayBuffer());
		if (closed) return;
		task = pdfjs.getDocument({ data, isEvalSupported: false, enableXfa: false });
		const pdf = await task.promise;
		if (closed) return;
		const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
		const pages = h('div', { class: 'pdf-pages' });
		const slots = [];
		for (let n = 1; n <= pdf.numPages; n++) {
			const slot = h('div', { class: 'pdf-page', 'data-page': n, style: `aspect-ratio: ${first.width} / ${first.height}` });
			slots.push(slot);
			pages.append(slot);
		}
		body.replaceChildren(pages, h('p', { class: 'hint pdf-count' }, `${pdf.numPages} ${pdf.numPages === 1 ? 'page' : 'pages'}`));
		// Only pages that come into view are drawn, each once, at the width they are shown.
		const draw = async slot => {
			if (slot.dataset.drawn || closed) return;
			slot.dataset.drawn = '1';
			const page = await pdf.getPage(Number(slot.dataset.page));
			const base = page.getViewport({ scale: 1 });
			const scale = ((slot.clientWidth || 800) * (devicePixelRatio || 1)) / base.width;
			const viewport = page.getViewport({ scale });
			const canvas = h('canvas', { width: Math.floor(viewport.width), height: Math.floor(viewport.height) });
			slot.style.aspectRatio = `${base.width} / ${base.height}`;
			slot.replaceChildren(canvas);
			await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
		};
		if (typeof IntersectionObserver === 'function') {
			const observer = new IntersectionObserver(entries => {
				for (const entry of entries) if (entry.isIntersecting) draw(entry.target).catch(err => console.warn('[peerkit] PDF page', err));
			}, { root: body, rootMargin: '100% 0px' });
			slots.forEach(slot => observer.observe(slot));
			cleanups.push(() => observer.disconnect());
		} else {
			draw(slots[0]).catch(() => {});
		}
	})().catch(err => {
		if (closed) return;
		console.warn('[peerkit] PDF viewer', err);
		notice(err?.name === 'PasswordException' ? 'This PDF has a password.' : 'This PDF can’t be shown here.');
	});
}

/** Text and code in a read-only CodeMirror with syntax colours. HTML is shown as its source, never rendered. */
function showText({ file, name, body, cleanups, notice, tools, onEdit }) {
	if (file.size > MAX_TEXT_BYTES) return notice(`This file is too large to show as text (over ${formatBytes(MAX_TEXT_BYTES)}).`);
	body.replaceChildren(spinner('Opening…'));
	let view = null;
	let closed = false;
	cleanups.push(() => {
		closed = true;
		view?.destroy();
	});
	(async () => {
		const [text, lib] = await Promise.all([file.text(), import('../../../vendor/editor.js')]);
		if (closed) return;
		if (text.includes('\0')) return notice('This is not a text file.');
		const lang = langOf(name);
		const host = h('div', { class: 'viewer-code' });
		body.replaceChildren(host);
		view = new lib.EditorView({
			parent: host,
			state: lib.EditorState.create({
				doc: text.replace(/\r\n?/g, '\n'),
				extensions: [
					lib.lineNumbers(),
					lib.highlightSpecialChars(),
					lib.foldGutter(),
					lib.EditorState.readOnly.of(true),
					lib.EditorView.lineWrapping,
					lib.search({ top: true }),
					highlighting(lib, darkScheme()),
					languageSupport(lib, lang),
					codeTheme(lib),
				],
			}),
		});
		if (onEdit) tools.prepend(button('Open as shared document', 'edit', onEdit, 'btn small'));
	})().catch(err => {
		if (closed) return;
		console.warn('[peerkit] text viewer', err);
		notice('This file can’t be shown here.', 'Check the internet connection, or download it.');
	});
}
