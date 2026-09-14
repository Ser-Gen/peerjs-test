import {
	ProfileError,
	TEST_TIMEOUT,
	blockedAsMixedContent,
	normalizeProfile,
	profiles,
	sameConnection,
	serverAddress,
	testServer,
} from '../settings.js';
import { MAX_NAME, device } from '../device.js';
import { copyText, defaultDeviceName } from '../util.js';
import { button, h, icon, openDialog, toast } from './dom.js';

const TEST_ERRORS = {
	timeout: `No answer within ${TEST_TIMEOUT / 1000} s. Check the host and port.`,
	'server-error': 'The server did not hand out an ID. Check host, port, path and the HTTPS setting.',
	network: 'Server unreachable. Check the internet connection and the host.',
	'socket-error': 'The WebSocket connection failed. Check the HTTPS setting and any proxy in front of the server.',
	'socket-closed': 'The server closed the connection.',
	'invalid-key': 'The server rejected the key.',
	'ssl-unavailable': 'The server does not support HTTPS.',
	'browser-incompatible': 'This browser does not support WebRTC.',
};

function describeTest({ ok, ms, error }) {
	if (ok) return { kind: 'ok', text: `✓ Connected in ${ms} ms` };
	return { kind: 'bad', text: `✗ ${TEST_ERRORS[error] ?? `Failed: ${error}`}` };
}

/** Settings screen: server profiles (select, test, add/edit/duplicate/delete) and JSON import/export. */
export class SettingsView {
	constructor(el, { onClose, sessionProfile }) {
		this.el = el;
		this.onClose = onClose;
		this.sessionProfile = sessionProfile;
		this.open = false;
		this.dialog = null;
		this.tests = new Map(); // profile id → { kind, text }
		profiles.on('change', () => {
			if (this.open) this.render();
		});
	}

	show() {
		this.open = true;
		this.render();
		this.el.scrollTop = 0;
	}

	hide() {
		this.open = false;
		this.dialog?.close();
	}

	render() {
		const current = this.sessionProfile();
		const list = profiles.list();
		const activeId = profiles.active.id;
		const currentSaved = list.some(p => sameConnection(p, current));

		this.el.replaceChildren(
			h('div', { class: 'settings-inner' },
				h('header', { class: 'settings-head' },
					h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Back', onclick: () => this.onClose() }, icon('back')),
					h('h1', {}, 'Settings')),

				h('section', { class: 'settings-section' },
					h('h2', {}, 'Signaling server'),
					h('p', { class: 'hint' },
						'Devices find each other through this server, so both must use the same one. ',
						'The pairing link and QR code carry it: the other device needs no setup.'),
					h('p', { class: 'hint' }, 'The selected server is used when you start a session.'),
					!currentSaved && h('p', { class: 'hint' }, `This session uses “${current.name}” from the link.`),
					h('ul', { class: 'profiles' }, list.map(p => this.renderProfile(p, p.id === activeId, sameConnection(p, current)))),
					button('Add server', 'plus', () => this.edit(null, {}), 'btn')),

				h('section', { class: 'settings-section' },
					h('h2', {}, 'This device'),
					h('label', { class: 'field' },
						h('span', {}, 'Name'),
						h('input', {
							class: 'input',
							value: device.customName,
							placeholder: defaultDeviceName(),
							maxlength: MAX_NAME,
							autocomplete: 'off',
							autocapitalize: 'sentences',
							enterkeyhint: 'done',
							onchange: e => this.saveName(e.target),
						}),
						h('small', {}, 'The other device sees this name, also when a host asks whether to let this device in. Used from the next connection.'))),

				h('section', { class: 'settings-section' },
					h('h2', {}, 'Backup'),
					h('p', { class: 'hint' }, 'Move your servers to another device without pairing.'),
					h('div', { class: 'actions start' },
						button('Export', 'download', () => this.exportProfiles(), 'btn'),
						button('Import', 'upload', () => this.importProfiles(), 'btn')))));
	}

	renderProfile(p, active, inUse) {
		const test = this.tests.get(p.id);
		return h('li', { class: 'profile', 'data-active': active },
			h('label', { class: 'profile-main' },
				h('input', { type: 'radio', name: 'active-profile', checked: active, onchange: () => this.attempt(() => profiles.setActive(p.id)) }),
				h('span', { class: 'profile-text' },
					h('span', { class: 'profile-name' }, h('span', {}, p.name), inUse && h('span', { class: 'badge' }, 'This session')),
					h('span', { class: 'profile-addr' }, serverAddress(p)))),
			h('div', { class: 'profile-actions' },
				button('Test', null, () => this.test(p)),
				!p.builtin && button('Edit', null, () => this.edit(p.id, p)),
				button('Duplicate', null, () => this.edit(null, p.builtin ? { ...p, name: '' } : { ...p, name: `${p.name} copy` })),
				!p.builtin && button('Delete', null, () => this.remove(p))),
			test && h('p', { class: 'test-result', 'data-kind': test.kind, role: 'status' }, test.text));
	}

	async test(p) {
		if (this.tests.get(p.id)?.kind === 'busy') return;
		this.tests.set(p.id, { kind: 'busy', text: 'Testing…' });
		this.render();
		const result = describeTest(await testServer(p));
		// The profile may have been edited or deleted meanwhile.
		if (this.tests.get(p.id)?.kind !== 'busy') return;
		this.tests.set(p.id, result);
		if (this.open) this.render();
	}

	remove(p) {
		if (!confirm(`Delete “${p.name}”?`)) return;
		this.attempt(() => {
			profiles.remove(p.id);
			this.tests.delete(p.id);
			toast('Server deleted');
		});
	}

	/** Editor dialog. `id` null adds a new profile prefilled from `base`. */
	edit(id, base) {
		const input = (name, value, props = {}) =>
			h('input', { class: 'input', name, value: value ?? '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', ...props });
		const field = (label, control, note) =>
			h('label', { class: 'field' }, h('span', {}, label), control, note && h('small', {}, note));

		const warn = h('p', { class: 'warn-text', hidden: true }, 'This page is served over HTTPS, so the browser will block an insecure server (except localhost).');
		const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
		const result = h('p', { class: 'test-result', role: 'status', hidden: true });

		const form = h('form', { class: 'sheet-body', novalidate: true },
			h('h2', {}, id ? 'Edit server' : 'Add server'),
			field('Host', input('host', base.host, { placeholder: 'peer.example.com', inputmode: 'url' }), 'You can paste a full URL, e.g. https://peer.example.com:9000/myapp'),
			h('div', { class: 'field-row' },
				field('Port', input('port', base.port, { type: 'number', inputmode: 'numeric', min: 1, max: 65535, placeholder: '443' })),
				field('Path', input('path', base.path, { placeholder: '/' }))),
			field('Key', input('key', base.key, { placeholder: 'peerjs' })),
			h('label', { class: 'check' },
				h('input', { type: 'checkbox', name: 'secure', checked: base.secure !== false }),
				h('span', {}, 'Secure connection (HTTPS)')),
			field('Name', input('name', base.name, { placeholder: 'e.g. Home server', maxlength: 40, autocapitalize: 'sentences' })),
			!id && h('label', { class: 'check' },
				h('input', { type: 'checkbox', name: 'activate', checked: true }),
				h('span', {}, 'Use for new sessions')),
			warn,
			error,
			result,
			h('div', { class: 'actions end' },
				button('Test', null, () => test(), 'btn push'),
				button('Cancel', null, () => dialog.close(), 'btn ghost'),
				h('button', { type: 'submit', class: 'btn primary' }, 'Save')));

		const dialog = this.openDialog(form);
		const get = name => form.elements.namedItem(name);
		const fields = () => ({
			...base,
			name: get('name').value,
			host: get('host').value,
			port: get('port').value,
			path: get('path').value,
			key: get('key').value,
			secure: get('secure').checked,
		});
		const showError = message => {
			error.textContent = message;
			error.hidden = !message;
		};
		const validate = () => {
			splitHostInput(get);
			showError('');
			try {
				return normalizeProfile(fields());
			} catch (err) {
				if (!(err instanceof ProfileError)) throw err;
				showError(err.message);
				return null;
			}
		};
		const updateWarn = () => {
			warn.hidden = !blockedAsMixedContent({ host: get('host').value.trim().toLowerCase(), secure: get('secure').checked });
		};

		let testing = false;
		const test = async () => {
			const profile = validate();
			if (!profile || testing) return;
			testing = true;
			result.hidden = false;
			result.dataset.kind = 'busy';
			result.textContent = 'Testing…';
			const outcome = describeTest(await testServer(profile));
			testing = false;
			result.dataset.kind = outcome.kind;
			result.textContent = outcome.text;
		};

		get('host').addEventListener('change', () => {
			splitHostInput(get);
			updateWarn();
		});
		get('secure').addEventListener('change', updateWarn);
		form.addEventListener('input', () => {
			if (!testing) result.hidden = true; // the result no longer matches the fields
		});
		form.addEventListener('submit', e => {
			e.preventDefault();
			const profile = validate();
			if (!profile) return;
			try {
				const saved = profiles.save(profile, { id, activate: !id && get('activate').checked });
				this.tests.delete(saved.id);
				dialog.close();
				toast(id ? 'Server updated' : `Added “${saved.name}”`);
			} catch (err) {
				if (!(err instanceof ProfileError)) throw err;
				showError(err.message);
			}
		});
		updateWarn();
	}

	exportProfiles() {
		if (profiles.list().length < 2) {
			toast('Nothing to export yet. Add a server first.');
			return;
		}
		const json = profiles.exportJSON();
		const area = h('textarea', { class: 'input code', rows: 8, readonly: true, 'aria-label': 'Exported servers' });
		area.value = json;
		area.addEventListener('focus', () => area.select());
		const dialog = this.openDialog(h('div', { class: 'sheet-body' },
			h('h2', {}, 'Export servers'),
			h('p', { class: 'hint' }, 'Copy this text and paste it into Settings → Import on the other device.'),
			area,
			h('div', { class: 'actions end' },
				navigator.share && button('Share…', 'share', () => navigator.share({ title: 'PeerKit servers', text: json }).catch(() => {}), 'btn push'),
				button('Close', null, () => dialog.close(), 'btn ghost'),
				button('Copy', 'copy', async () => toast((await copyText(json)) ? 'Copied' : 'Copy failed'), 'btn primary'))));
	}

	importProfiles() {
		const area = h('textarea', { class: 'input code', rows: 8, placeholder: 'Paste exported servers or a PeerKit link', 'aria-label': 'Servers to import' });
		const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
		const form = h('form', { class: 'sheet-body' },
			h('h2', {}, 'Import servers'),
			h('p', { class: 'hint' }, 'Servers that are already saved are skipped. A PeerKit link with a custom server works too.'),
			area,
			error,
			h('div', { class: 'actions end' },
				button('Cancel', null, () => dialog.close(), 'btn ghost'),
				h('button', { type: 'submit', class: 'btn primary' }, 'Import')));
		const dialog = this.openDialog(form);
		form.addEventListener('submit', e => {
			e.preventDefault();
			try {
				const { added, existing, invalid } = profiles.importText(area.value);
				dialog.close();
				toast([
					`Added ${added} server${added === 1 ? '' : 's'}`,
					existing && `${existing} already saved`,
					invalid && `${invalid} invalid skipped`,
				].filter(Boolean).join(' · '));
			} catch (err) {
				if (!(err instanceof ProfileError)) throw err;
				error.textContent = err.message;
				error.hidden = false;
			}
		});
	}

	saveName(input) {
		const name = device.setName(input.value);
		input.value = device.customName;
		toast(`This device is “${name}”`);
	}

	openDialog(content) {
		this.dialog?.close();
		const dialog = openDialog(content);
		dialog.addEventListener('close', () => {
			if (this.dialog === dialog) this.dialog = null;
		});
		this.dialog = dialog;
		return dialog;
	}

	attempt(fn) {
		try {
			fn();
		} catch (err) {
			if (!(err instanceof ProfileError)) throw err;
			toast(err.message);
		}
	}
}

/** Turn a pasted URL in the Host field ("https://peer.example.com:9000/app") into host, port, path and secure. */
function splitHostInput(get) {
	const raw = get('host').value.trim();
	if (!/[:/]/.test(raw)) return;
	const scheme = raw.match(/^([a-z]+):\/\//i)?.[1].toLowerCase();
	let url;
	try {
		url = new URL(scheme ? raw : `https://${raw}`);
	} catch {
		return; // leave it for validation to report
	}
	get('host').value = url.hostname;
	if (scheme === 'https' || scheme === 'wss') get('secure').checked = true;
	if (scheme === 'http' || scheme === 'ws') get('secure').checked = false;
	if (url.port) get('port').value = url.port;
	else if (scheme) get('port').value = get('secure').checked ? 443 : 80;
	if (url.pathname !== '/') get('path').value = url.pathname;
}
