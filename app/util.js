export function randomId(bytes = 8) {
	return [...crypto.getRandomValues(new Uint8Array(bytes))]
		.map(b => b.toString(16).padStart(2, '0'))
		.join('');
}

export function randomInt(max) {
	return crypto.getRandomValues(new Uint32Array(1))[0] % max;
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** localStorage JSON that never throws: null when missing, unreadable or blocked. */
export function readJSON(key) {
	try {
		return JSON.parse(localStorage.getItem(key));
	} catch {
		return null;
	}
}

export function writeJSON(key, value) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
		return true;
	} catch (err) {
		console.warn(`[peerkit] could not save ${key}`, err);
		return false;
	}
}

let idbCheck = null;

/**
 * IndexedDB can be missing or refuse to open (private windows, blocked site data). y-indexeddb then never
 * resolves `whenSynced` and leaves the rejection unhandled, so try a separate small database first.
 */
export function indexedDBUsable(wait = 4000) {
	idbCheck ??= new Promise(resolve => {
		setTimeout(() => resolve(false), wait); // blocked IndexedDB never answers
		try {
			const request = indexedDB.open('peerkit.check');
			request.onsuccess = () => {
				request.result.close();
				resolve(true);
			};
			request.onerror = () => resolve(false);
		} catch {
			resolve(false);
		}
	});
	return idbCheck;
}

/** A readable name until the user sets one: "Android phone", "Chrome on Mac"… */
export function defaultDeviceName() {
	const ua = navigator.userAgent;
	if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
	if (/iPhone/.test(ua)) return 'iPhone';
	if (/iPad/.test(ua)) return 'iPad';
	const browser = /Edg\//.test(ua) ? 'Edge'
		: /OPR\//.test(ua) ? 'Opera'
		: /Firefox\//.test(ua) ? 'Firefox'
		: /Chrome\//.test(ua) ? 'Chrome'
		: /Safari\//.test(ua) ? 'Safari'
		: 'Browser';
	const os = /Windows/.test(ua) ? 'Windows'
		: /Mac OS X/.test(ua) ? 'Mac'
		: /CrOS/.test(ua) ? 'ChromeOS'
		: /Linux/.test(ua) ? 'Linux'
		: '';
	return os ? `${browser} on ${os}` : browser;
}

export function formatBytes(n) {
	if (!Number.isFinite(n)) return '—';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let i = 0;
	while (n >= 1024 && i < units.length - 1) {
		n /= 1024;
		i++;
	}
	return `${i && n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export const formatSpeed = bytesPerSecond => `${formatBytes(bytesPerSecond)}/s`;

export function formatDuration(seconds) {
	const s = Math.max(0, Math.ceil(seconds));
	if (s < 60) return `${s} s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m} min ${s % 60} s`;
	return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function timeAgo(time, now = Date.now()) {
	const minutes = Math.round((now - time) / 60000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.round(hours / 24);
	if (days === 1) return 'yesterday';
	if (days < 7) return `${days} days ago`;
	return new Date(time).toLocaleDateString();
}

export async function copyText(text) {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		// Clipboard API needs a secure context; fall back for http://<lan-ip> testing.
		const ta = document.createElement('textarea');
		ta.value = text;
		ta.style.position = 'fixed';
		ta.style.opacity = '0';
		document.body.append(ta);
		ta.select();
		const ok = document.execCommand('copy');
		ta.remove();
		return ok;
	}
}

/**
 * Hold a cross-tab lock while this page lives, so two tabs don't fight over one peer ID.
 * Resolves false if another tab has it. `steal` takes it over, and the losing tab's `onLost` runs.
 * Without the Web Locks API (insecure context) every tab gets the lock.
 */
export function claimTab(name, { steal = false, onLost } = {}) {
	if (!navigator.locks?.request) return Promise.resolve(true);
	return new Promise(resolve => {
		navigator.locks
			.request(name, steal ? { steal: true } : { ifAvailable: true }, lock => {
				resolve(Boolean(lock));
				return lock ? new Promise(() => {}) : undefined; // held until the page goes away
			})
			.catch(err => {
				if (err?.name === 'AbortError') {
					onLost?.();
				} else {
					console.warn('[peerkit] tab lock failed', err);
					resolve(true);
				}
			});
	});
}

/** Reference-counted screen wake lock; re-acquired when the page becomes visible again. */
export const wakeLock = {
	count: 0,
	sentinel: null,

	acquire() {
		if (++this.count === 1) this._request();
	},

	release() {
		if (this.count === 0 || --this.count > 0) return;
		this.sentinel?.release().catch(() => {});
		this.sentinel = null;
	},

	async _request() {
		if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
		try {
			const sentinel = await navigator.wakeLock.request('screen');
			if (this.count === 0) sentinel.release().catch(() => {});
			else this.sentinel = sentinel;
		} catch {
			// Denied (e.g. battery saver) — transfers still work, the screen may just sleep.
		}
	},
};

document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'visible' && wakeLock.count > 0 && (!wakeLock.sentinel || wakeLock.sentinel.released)) {
		wakeLock._request();
	}
});
