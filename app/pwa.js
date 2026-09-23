/*
 * Installing PeerKit: the service worker (sw.js) and Chrome's install prompt.
 * The worker is what makes the app installable at all, and an installed app is what Android offers in its
 * share sheet, so this is the other half of app/share.js.
 */
const listeners = new Set();
let deferred = null; // Chrome's beforeinstallprompt event, kept until the user asks for it

if (typeof window !== 'undefined') {
	window.addEventListener('beforeinstallprompt', event => {
		event.preventDefault(); // otherwise Chrome shows its own bar; Settings offers it instead
		deferred = event;
		changed();
	});
	window.addEventListener('appinstalled', () => {
		deferred = null;
		changed();
	});
}

function changed() {
	for (const fn of listeners) fn();
}

/** Register the worker. It needs a secure context, so http://<lan-ip> simply has no worker. */
export function registerServiceWorker() {
	if (!navigator.serviceWorker) return;
	const url = new URL('../sw.js', import.meta.url);
	const start = () => navigator.serviceWorker.register(url, { scope: new URL('./', url).href }).catch(() => {});
	// After load: registering fetches the whole app shell, which would compete with opening the room.
	if (document.readyState === 'complete') start();
	else window.addEventListener('load', start, { once: true });
}

export const install = {
	/** Chrome offered an install prompt (Android and desktop Chrome; other browsers install from their menu). */
	get offered() {
		return Boolean(deferred);
	},
	/** The app is running as an installed app. */
	get standalone() {
		return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
	},
	async run() {
		const event = deferred;
		if (!event) return false;
		deferred = null; // the prompt can be used once
		changed();
		try {
			await event.prompt();
			const { outcome } = await event.userChoice;
			return outcome === 'accepted';
		} catch {
			return false;
		}
	},
	on(fn) {
		listeners.add(fn);
		return () => listeners.delete(fn);
	},
};
