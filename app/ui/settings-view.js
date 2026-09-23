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
import { TLS_PORT, TURN_PORT, TurnError, canMint, normalizeTurn, testTurn, turnSettings } from '../turn.js';
import { APP_VERSION } from '../version.js';
import { install } from '../pwa.js';
import { PROTOCOL_VERSION } from '../protocol.js';
import { copyText, defaultDeviceName } from '../util.js';
import { button, h, icon, openDialog, toast } from './dom.js';

const TURN_TEST = 'turn'; // key in `tests`; profile ids are hex

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

function describeTurnTest({ ok, ms, results, error }, server) {
	if (error === 'insecure') return { kind: 'bad', text: '✗ A shared secret needs HTTPS. Open PeerKit over https:// to use it.' };
	if (error) return { kind: 'bad', text: '✗ Could not create credentials from the secret.' };
	const failed = results.filter(r => !r.ok).map(r => r.transport);
	if (ok) {
		const passed = results.filter(r => r.ok).map(r => r.transport);
		return { kind: 'ok', text: `✓ Relay works over ${passed.join(', ')} in ${ms} ms${failed.length ? ` · ${failed.join(', ')} failed` : ''}` };
	}
	if (results.some(r => r.error === 'auth')) {
		return { kind: 'bad', text: '✗ The server rejected the credentials. Check the secret (or username and password) and the server clock.' };
	}
	const ports = `${server.port} (UDP/TCP)${server.tlsPort ? ` or ${server.tlsPort} (TLS)` : ''}`;
	return { kind: 'bad', text: `✗ No relay: nothing answered on ${ports}. Check the host, the firewall and that coturn is running.` };
}

function turnSummary(server) {
	return [
		`UDP/TCP ${server.port}`,
		server.tlsPort ? `TLS ${server.tlsPort}` : 'no TLS',
		server.secret ? 'shared secret' : `user ${server.username}`,
	].join(' · ');
}

const input = (name, value, props = {}) =>
	h('input', { class: 'input', name, value: value ?? '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', ...props });

const field = (label, control, note) =>
	h('label', { class: 'field' }, h('span', {}, label), control, note && h('small', {}, note));

/** Settings screen: server profiles (select, test, add/edit/duplicate/delete) and JSON import/export. */
export class SettingsView {
	constructor(el, { onClose, sessionProfile, ice = null }) {
		this.el = el;
		this.onClose = onClose;
		this.sessionProfile = sessionProfile;
		this.ice = ice; // the room's IceConfig: which TURN credentials it uses
		this.open = false;
		this.dialog = null;
		this.tests = new Map(); // profile id or TURN_TEST → { kind, text }
		const rerender = () => {
			if (this.open) this.render();
		};
		profiles.on('change', rerender);
		turnSettings.on('change', rerender);
		install.on(rerender); // Chrome offers the install prompt some time after the page loads
		ice?.on('change', rerender);
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
		const currentSaved = !current || list.some(p => sameConnection(p, current)); // current: null outside a room

		this.el.replaceChildren(
			h('div', { class: 'settings-inner' },
				h('header', { class: 'settings-head' },
					h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Back', onclick: () => this.onClose() }, icon('back')),
					h('h1', {}, 'Settings')),

				h('section', { class: 'settings-section' },
					h('h2', {}, 'Signaling server'),
					h('p', { class: 'hint' },
						'Devices find each other through this server, so both must use the same one. ',
						'Room links and QR codes carry it: other devices need no setup.'),
					h('p', { class: 'hint' }, 'The selected server is used for new rooms and typed room codes.'),
					!currentSaved && h('p', { class: 'hint' }, `This room uses “${current.name}” from its link.`),
					h('ul', { class: 'profiles' }, list.map(p => this.renderProfile(p, p.id === activeId, Boolean(current) && sameConnection(p, current)))),
					button('Add server', 'plus', () => this.edit(null, {}), 'btn')),

				this.renderTurn(),

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
						h('small', {}, 'Others in the room see this name.'))),

				h('section', { class: 'settings-section' },
					h('h2', {}, 'Backup'),
					h('p', { class: 'hint' }, 'Move your servers and TURN settings to another device.'),
					h('div', { class: 'actions start' },
						button('Export', 'download', () => this.exportProfiles(), 'btn'),
						button('Import', 'upload', () => this.importProfiles(), 'btn'))),

				h('section', { class: 'settings-section' },
					h('h2', {}, 'Install'),
					this.renderInstall()),

				h('section', { class: 'settings-section' },
					h('h2', {}, 'About'),
					h('p', { class: 'version' }, `PeerKit ${APP_VERSION} · room protocol ${PROTOCOL_VERSION}`),
					h('p', { class: 'hint' }, 'Devices in one room need the same protocol number, so reload every device after an update.'))));
	}

	/** Installing makes PeerKit open like an app, and puts it in Android's share sheet (Share → PeerKit). */
	renderInstall() {
		if (install.standalone) {
			return [
				h('p', { class: 'hint' }, 'PeerKit is installed on this device.'),
				h('p', { class: 'hint' }, 'Share a photo or a file from another app to PeerKit and it offers to send it to the open room.'),
			];
		}
		return [
			h('p', { class: 'hint' }, 'An installed PeerKit opens from the home screen and shows up in Android’s share sheet, so a photo or a file can go straight into the room.'),
			install.offered
				? h('div', { class: 'actions start' }, button('Install PeerKit', 'download', () => install.run(), 'btn'))
				: h('p', { class: 'hint' }, 'Install it from the browser menu: “Install app”, or “Add to home screen” on Android. It needs the https:// address.'),
		];
	}

	renderProfile(p, active, inUse) {
		const test = this.tests.get(p.id);
		return h('li', { class: 'profile', 'data-active': active },
			h('label', { class: 'profile-main' },
				h('input', { type: 'radio', name: 'active-profile', checked: active, onchange: () => this.attempt(() => profiles.setActive(p.id)) }),
				h('span', { class: 'profile-text' },
					h('span', { class: 'profile-name' }, h('span', {}, p.name), inUse && h('span', { class: 'badge' }, 'This room')),
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
				h('span', {}, 'Use for new rooms')),
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

	renderTurn() {
		const server = turnSettings.server;
		const test = this.tests.get(TURN_TEST);
		const source = this.ice?.source;
		return h('section', { class: 'settings-section' },
			h('h2', {}, 'TURN server'),
			h('p', { class: 'hint' },
				'Relays the connection when the devices can’t reach each other directly, e.g. on mobile data or strict Wi-Fi. ',
				'This device uses it in every room, with any signaling server, and gives the other members temporary credentials. ',
				h('a', { href: 'docs/turn-server.md', target: '_blank', rel: 'noopener' }, 'Server setup guide')),
			server
				? h('div', { class: 'profile turn' },
					h('span', { class: 'profile-text' },
						h('span', { class: 'profile-name' }, h('span', {}, server.host), source === 'own' && h('span', { class: 'badge' }, 'In use')),
						h('span', { class: 'profile-addr' }, turnSummary(server))),
					server.secret && !canMint() && h('p', { class: 'warn-text' }, 'This page isn’t served over HTTPS, so the secret can’t be used here.'),
					h('div', { class: 'profile-actions' },
						button('Test', null, () => this.testTurn(server)),
						button('Edit', null, () => this.editTurn(server)),
						button('Remove', null, () => this.removeTurn())),
					test && h('p', { class: 'test-result', 'data-kind': test.kind, role: 'status' }, test.text))
				: button('Add TURN server', 'plus', () => this.editTurn(null), 'btn'),
			source === 'room' && h('p', { class: 'hint' }, 'This room uses temporary TURN credentials from another member.'),
			h('label', { class: 'check' },
				h('input', { type: 'checkbox', checked: turnSettings.relayOnly, onchange: e => this.attempt(() => turnSettings.setRelayOnly(e.target.checked)) }),
				h('span', {}, 'Relay only (for testing)')),
			h('p', { class: 'hint' }, 'Sends new connections through the TURN server even when a direct route exists. Has no effect without TURN credentials.'));
	}

	async testTurn(server) {
		if (this.tests.get(TURN_TEST)?.kind === 'busy') return;
		this.tests.set(TURN_TEST, { kind: 'busy', text: 'Testing…' });
		this.render();
		const result = describeTurnTest(await testTurn(server), server);
		// The server may have been edited or removed meanwhile.
		if (this.tests.get(TURN_TEST)?.kind !== 'busy') return;
		this.tests.set(TURN_TEST, result);
		if (this.open) this.render();
	}

	removeTurn() {
		if (!confirm('Remove the TURN server from this device?')) return;
		this.attempt(() => {
			this.tests.delete(TURN_TEST);
			turnSettings.remove();
			toast('TURN server removed');
		});
	}

	/** TURN editor dialog; `base` is the saved server or null. */
	editTurn(base) {
		const secretMode = h('input', { type: 'radio', name: 'auth', value: 'secret', checked: !base?.username });
		const passwordMode = h('input', { type: 'radio', name: 'auth', value: 'password', checked: Boolean(base?.username) });
		const secretField = field('Secret', input('secret', base?.secret, { type: 'password', placeholder: 'static-auth-secret' }),
			'Stays on this device. Room links and other members get temporary credentials made from it.');
		const showSecret = h('label', { class: 'check' },
			h('input', { type: 'checkbox', onchange: e => (get('secret').type = e.target.checked ? 'text' : 'password') }),
			h('span', {}, 'Show secret'));
		const userField = field('Username', input('username', base?.username));
		const passwordField = field('Password', input('credential', base?.credential, { type: 'password' }),
			'Goes into room links as it is, so everyone in the room can use it.');
		const insecure = h('p', { class: 'warn-text', hidden: true }, 'This page isn’t served over HTTPS, so a shared secret can’t be used here.');
		const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
		const result = h('p', { class: 'test-result', role: 'status', hidden: true });

		const form = h('form', { class: 'sheet-body', novalidate: true },
			h('h2', {}, base ? 'Edit TURN server' : 'Add TURN server'),
			field('Host', input('host', base?.host, { placeholder: 'turn.example.com', inputmode: 'url' }), 'You can paste a turn: or turns: URL.'),
			h('div', { class: 'field-row' },
				field('Port', input('port', base?.port ?? TURN_PORT, { type: 'number', inputmode: 'numeric', min: 1, max: 65535, placeholder: String(TURN_PORT) }), 'UDP and TCP'),
				field('TLS port', input('tlsPort', base ? base.tlsPort : TLS_PORT, { type: 'number', inputmode: 'numeric', min: 1, max: 65535, placeholder: 'Off' }), 'Empty: no TLS')),
			h('div', { class: 'field', role: 'radiogroup', 'aria-label': 'Authentication' },
				h('span', {}, 'Authentication'),
				h('label', { class: 'check' }, secretMode, h('span', {}, 'Shared secret (coturn use-auth-secret)')),
				h('label', { class: 'check' }, passwordMode, h('span', {}, 'Username and password'))),
			secretField,
			showSecret,
			userField,
			passwordField,
			insecure,
			error,
			result,
			h('div', { class: 'actions end' },
				button('Test', null, () => test(), 'btn push'),
				button('Cancel', null, () => dialog.close(), 'btn ghost'),
				h('button', { type: 'submit', class: 'btn primary' }, 'Save')));

		const dialog = this.openDialog(form);
		const get = name => form.elements.namedItem(name);
		const usesSecret = () => secretMode.checked;
		const updateMode = () => {
			secretField.hidden = showSecret.hidden = !usesSecret();
			userField.hidden = passwordField.hidden = usesSecret();
			insecure.hidden = !usesSecret() || canMint();
		};
		const fields = () => ({
			host: get('host').value,
			port: get('port').value,
			tlsPort: get('tlsPort').value,
			...(usesSecret() ? { secret: get('secret').value } : { username: get('username').value, credential: get('credential').value }),
		});
		const showError = message => {
			error.textContent = message;
			error.hidden = !message;
		};
		const validate = () => {
			splitTurnHost(get);
			showError('');
			try {
				return normalizeTurn(fields());
			} catch (err) {
				if (!(err instanceof TurnError)) throw err;
				showError(err.message);
				return null;
			}
		};

		let testing = false;
		const test = async () => {
			const server = validate();
			if (!server || testing) return;
			testing = true;
			result.hidden = false;
			result.dataset.kind = 'busy';
			result.textContent = 'Testing…';
			const outcome = describeTurnTest(await testTurn(server), server);
			testing = false;
			result.dataset.kind = outcome.kind;
			result.textContent = outcome.text;
		};

		secretMode.addEventListener('change', updateMode);
		passwordMode.addEventListener('change', updateMode);
		get('host').addEventListener('change', () => splitTurnHost(get));
		form.addEventListener('input', () => {
			if (!testing) result.hidden = true; // the result no longer matches the fields
		});
		form.addEventListener('submit', e => {
			e.preventDefault();
			const server = validate();
			if (!server) return;
			try {
				turnSettings.save(server);
				this.tests.delete(TURN_TEST);
				dialog.close();
				toast(base ? 'TURN server updated' : 'TURN server added');
			} catch (err) {
				if (!(err instanceof TurnError)) throw err;
				showError(err.message);
			}
		});
		updateMode();
	}

	exportProfiles() {
		const turn = turnSettings.server;
		if (profiles.list().length < 2 && !turn) {
			toast('Nothing to export yet. Add a server first.');
			return;
		}
		const json = profiles.exportJSON({ turn: turn ?? undefined });
		const area = h('textarea', { class: 'input code', rows: 8, readonly: true, 'aria-label': 'Exported servers' });
		area.value = json;
		area.addEventListener('focus', () => area.select());
		const dialog = this.openDialog(h('div', { class: 'sheet-body' },
			h('h2', {}, 'Export servers'),
			h('p', { class: 'hint' }, 'Copy this text and paste it into Settings → Import on the other device.'),
			turn?.secret && h('p', { class: 'warn-text' }, 'It includes your TURN secret. Send it only to your own devices.'),
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
			h('p', { class: 'hint' }, 'Servers that are already saved are skipped. A TURN server in the text replaces this device’s. A PeerKit link with a custom server works too.'),
			area,
			error,
			h('div', { class: 'actions end' },
				button('Cancel', null, () => dialog.close(), 'btn ghost'),
				h('button', { type: 'submit', class: 'btn primary' }, 'Import')));
		const dialog = this.openDialog(form);
		form.addEventListener('submit', e => {
			e.preventDefault();
			try {
				const { added, existing, invalid, turn } = profiles.importText(area.value);
				let turnSaved = false;
				if (turn) {
					try {
						turnSettings.save(turn);
						turnSaved = true;
					} catch (err) {
						if (!(err instanceof TurnError)) throw err;
					}
				}
				dialog.close();
				toast([
					(added || existing || invalid || !turn) && `Added ${added} server${added === 1 ? '' : 's'}`,
					existing && `${existing} already saved`,
					invalid && `${invalid} invalid skipped`,
					turn && (turnSaved ? 'TURN server imported' : 'TURN server invalid, skipped'),
				].filter(Boolean).join(' · '));
			} catch (err) {
				if (!(err instanceof ProfileError || err instanceof TurnError)) throw err;
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
			if (!(err instanceof ProfileError || err instanceof TurnError)) throw err;
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

/** Turn a pasted "turns:turn.example.com:5349?transport=tcp" into host and the matching port. */
function splitTurnHost(get) {
	const raw = get('host').value.trim();
	const match = raw.match(/^(turns?|stuns?):([^:?/\s]+)(?::(\d{1,5}))?/i);
	if (match) {
		get('host').value = match[2];
		if (match[3]) get(match[1].toLowerCase() === 'turns' ? 'tlsPort' : 'port').value = match[3];
		return;
	}
	if (!/^[a-z]+:\/\//i.test(raw)) return;
	try {
		get('host').value = new URL(raw).hostname;
	} catch {
		// leave it for validation to report
	}
}
