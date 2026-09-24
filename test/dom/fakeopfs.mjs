// A small in-memory origin private file system (navigator.storage.getDirectory) for the chat's kept files.
// Writes go to a swap copy until close(), as in the browser, so an unfinished file keeps its old contents.

let clock = Date.now(); // lastModified never ties, so "the oldest file" is always one file

const error = name => Object.assign(new Error(name), { name });

class FakeFileHandle {
	kind = 'file';

	constructor(name) {
		this.name = name;
		this.data = new Uint8Array(0);
		this.modified = ++clock;
	}

	async getFile() {
		return new File([this.data], this.name, { lastModified: this.modified });
	}

	async createWritable({ keepExistingData = false } = {}) {
		const handle = this;
		const pieces = keepExistingData ? [handle.data] : [];
		let closed = false;
		return {
			async write(data) {
				if (closed) throw error('InvalidStateError');
				const bytes = data instanceof Uint8Array ? data : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
				pieces.push(bytes.slice());
			},
			async close() {
				if (closed) throw error('InvalidStateError');
				closed = true;
				const size = pieces.reduce((sum, piece) => sum + piece.byteLength, 0);
				const all = new Uint8Array(size);
				let offset = 0;
				for (const piece of pieces) {
					all.set(piece, offset);
					offset += piece.byteLength;
				}
				handle.data = all;
				handle.modified = ++clock;
			},
			async abort() {
				closed = true;
			},
		};
	}
}

class FakeDirectoryHandle {
	kind = 'directory';

	constructor(name) {
		this.name = name;
		this.children = new Map();
	}

	async getDirectoryHandle(name, { create = false } = {}) {
		let child = this.children.get(name);
		if (!child) {
			if (!create) throw error('NotFoundError');
			this.children.set(name, (child = new FakeDirectoryHandle(name)));
		}
		if (child.kind !== 'directory') throw error('TypeMismatchError');
		return child;
	}

	async getFileHandle(name, { create = false } = {}) {
		let child = this.children.get(name);
		if (!child) {
			if (!create) throw error('NotFoundError');
			this.children.set(name, (child = new FakeFileHandle(name)));
		}
		if (child.kind !== 'file') throw error('TypeMismatchError');
		return child;
	}

	async removeEntry(name, { recursive = false } = {}) {
		const child = this.children.get(name);
		if (!child) throw error('NotFoundError');
		if (child.kind === 'directory' && child.children.size && !recursive) throw error('InvalidModificationError');
		this.children.delete(name);
	}

	async *entries() {
		for (const entry of [...this.children]) yield entry;
	}
}

/** Put a fresh file system on `navigator.storage`; returns its root, for the test to look into. */
export function installFakeOpfs(navigator) {
	const root = new FakeDirectoryHandle('');
	Object.defineProperty(navigator, 'storage', {
		value: {
			getDirectory: async () => root,
			estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }),
			persist: async () => true,
		},
		configurable: true,
	});
	return root;
}
