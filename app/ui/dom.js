/** Tiny element builder: h('button', { class: 'btn', onclick }, 'Label'). */
export function h(tag, props = {}, ...children) {
	const el = document.createElement(tag);
	for (const [key, value] of Object.entries(props ?? {})) {
		if (value == null || value === false) continue;
		if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
		else if (key === 'class') el.className = value;
		else el.setAttribute(key, value === true ? '' : value);
	}
	for (const child of children.flat()) {
		if (child != null && child !== false) el.append(child);
	}
	return el;
}

const ICONS = {
	attach: '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
	send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
	copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
	download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
	share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>',
	file: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>',
	close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
};

export function icon(name) {
	const span = h('span', { class: 'icon', 'aria-hidden': 'true' });
	// Static, trusted markup only.
	span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ''}</svg>`;
	return span;
}

export function button(label, iconName, onclick, className = 'btn small') {
	return h('button', { type: 'button', class: className, onclick }, iconName && icon(iconName), label);
}

const URL_RE = /\bhttps?:\/\/[^\s<>"]+/gi;

/** Render untrusted text with http(s) URLs as links, without ever using innerHTML. */
export function linkify(text) {
	const frag = document.createDocumentFragment();
	let last = 0;
	for (const match of text.matchAll(URL_RE)) {
		const trailing = match[0].match(/[)\].,!?;:'»]+$/);
		const url = trailing ? match[0].slice(0, -trailing[0].length) : match[0];
		frag.append(text.slice(last, match.index), h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url));
		last = match.index + url.length;
	}
	frag.append(text.slice(last));
	return frag;
}

export function toast(message) {
	const el = h('div', { class: 'toast', role: 'status' }, message);
	document.getElementById('toasts').append(el);
	setTimeout(() => el.remove(), 2500);
}

export const timeLabel = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
