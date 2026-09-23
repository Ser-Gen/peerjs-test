// Runs the real sw.js outside a browser: a fake Cache Storage, a fetch that reads the repo from disk, and
// the worker's own event listeners. app/share.js reads the same fake caches, so the two sides are tested
// against each other instead of against a copy of what they are supposed to do.
import { readFileSync, statSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const keyOf = (request, base) => new URL(typeof request === 'string' ? request : request.url, base).href;
const withoutSearch = href => {
	const url = new URL(href);
	url.search = '';
	return url.href;
};

class FakeCache {
	constructor(base, fetch) {
		this.base = base;
		this.fetch = fetch;
		this.entries = new Map(); // url → Response
	}

	async put(request, response) {
		this.entries.set(keyOf(request, this.base), response);
	}

	async match(request, { ignoreSearch = false } = {}) {
		const href = keyOf(request, this.base);
		let response = this.entries.get(href);
		if (!response && ignoreSearch) {
			for (const [key, value] of this.entries) if (withoutSearch(key) === withoutSearch(href)) response = value;
		}
		return response ? response.clone() : undefined;
	}

	async add(name) {
		const response = await this.fetch(keyOf(name, this.base));
		if (!response.ok) throw new Error(`cache.add: ${response.status} ${name}`);
		await this.put(keyOf(name, this.base), response);
	}

	async keys() {
		return [...this.entries.keys()].map(href => new Request(href));
	}

	async delete(request) {
		return this.entries.delete(keyOf(request, this.base));
	}
}

export function fakeCaches(base, fetch) {
	const caches = new Map(); // name → FakeCache
	return {
		store: caches,
		api: {
			async open(name) {
				if (!caches.has(name)) caches.set(name, new FakeCache(base, fetch));
				return caches.get(name);
			},
			async keys() {
				return [...caches.keys()];
			},
			async has(name) {
				return caches.has(name);
			},
			async delete(name) {
				return caches.delete(name);
			},
			async match(request, options) {
				for (const cache of caches.values()) {
					const response = await cache.match(request, options);
					if (response) return response;
				}
				return undefined;
			},
		},
	};
}

/** Serves the repo like a static host: "/" and "/x/" are that directory's index.html. */
export function diskFetch(root, base) {
	return async input => {
		const href = typeof input === 'string' ? input : input.url;
		const url = new URL(href, base);
		let path = root + decodeURIComponent(url.pathname);
		try {
			if (statSync(path).isDirectory()) path = `${path.replace(/\/$/, '')}/index.html`;
			return new Response(readFileSync(path), { status: 200 });
		} catch {
			return new Response('not found', { status: 404 });
		}
	};
}

/** Load sw.js and hand back its events. `fetch` is what the worker sees, so a test can make the network fail. */
export function loadServiceWorker(file, { scope, caches, fetch }) {
	const listeners = new Map();
	const self = {
		addEventListener: (type, fn) => listeners.set(type, fn),
		registration: { scope },
		location: new URL(scope),
		skipWaiting: () => {},
		clients: { claim: async () => {} },
	};
	const context = createContext({ self, caches, fetch, Response, Request, Headers, URL, Date, JSON, Promise, console, setTimeout });
	runInContext(readFileSync(file, 'utf8'), context, { filename: file });

	const lifecycle = async type => {
		const waiting = [];
		listeners.get(type)?.({ waitUntil: promise => waiting.push(promise) });
		await Promise.all(waiting);
	};
	return {
		install: () => lifecycle('install'),
		activate: () => lifecycle('activate'),
		/** The response the worker gives for a request, or null when it leaves it to the browser. */
		async request(request) {
			let answer = null;
			listeners.get('fetch')?.({ request, respondWith: promise => (answer = promise) });
			return answer === null ? null : await answer;
		},
	};
}
