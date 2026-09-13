export function randomId(bytes = 8) {
	return [...crypto.getRandomValues(new Uint8Array(bytes))]
		.map(b => b.toString(16).padStart(2, '0'))
		.join('');
}

let memoryDeviceId;

/**
 * Identifies this tab across reloads, so a reloaded guest can take over its own
 * stale connection instead of being refused as a second device.
 */
export function deviceId() {
	try {
		let id = sessionStorage.getItem('peerkit.deviceId');
		if (!id) sessionStorage.setItem('peerkit.deviceId', (id = randomId()));
		return id;
	} catch {
		return (memoryDeviceId ??= randomId());
	}
}

export function deviceName() {
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
