export class Emitter {
	#listeners = new Map();

	/** Subscribe; returns an unsubscribe function. */
	on(type, fn) {
		let set = this.#listeners.get(type);
		if (!set) this.#listeners.set(type, (set = new Set()));
		set.add(fn);
		return () => set.delete(fn);
	}

	emit(type, ...args) {
		for (const fn of [...(this.#listeners.get(type) ?? [])]) {
			try {
				fn(...args);
			} catch (err) {
				console.error(`[peerkit] "${type}" listener failed`, err);
			}
		}
	}
}
