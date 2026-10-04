import { isState, romKind } from './emulator.js';

/*
 * This device's ROMs and save states, in IndexedDB `peerkit.nes` (not per room: a ROM and its saves belong to the
 * device). Store `roms`: {hash, name, size, bytes, used}, the last MAX_ROMS opened, for Continue. Store `states`:
 * {id: "<hash>/<slot>", hash, slot, time, bytes}, SLOTS per ROM, kept when their ROM is dropped (opening it again
 * brings them back). Everything read is checked.
 */

const DB_NAME = 'peerkit.nes';
const DB_VERSION = 1;
export const MAX_ROMS = 8;
export const SLOTS = 3;
const HASH = /^[0-9a-f]{64}$/;

const done = request => new Promise((resolve, reject) => {
	request.onsuccess = () => resolve(request.result);
	request.onerror = () => reject(request.error);
});

const readRom = r => (r && HASH.test(r.hash) && typeof r.name === 'string' && r.bytes instanceof Uint8Array && romKind(r.bytes)
	? { hash: r.hash, name: r.name.slice(0, 100), size: r.bytes.length, bytes: r.bytes, used: Number(r.used) || 0 }
	: null);

const readSave = r => (r && HASH.test(r.hash) && Number.isInteger(r.slot) && r.slot >= 1 && r.slot <= SLOTS && r.bytes instanceof Uint8Array && isState(r.bytes)
	? { hash: r.hash, slot: r.slot, time: Number(r.time) || 0, bytes: r.bytes }
	: null);

export class Library {
	static async open() {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains('roms')) db.createObjectStore('roms', { keyPath: 'hash' });
			if (!db.objectStoreNames.contains('states')) db.createObjectStore('states', { keyPath: 'id' }).createIndex('hash', 'hash');
		};
		return new Library(await done(request));
	}

	constructor(db) {
		this.db = db;
	}

	store(name, mode = 'readonly') {
		return this.db.transaction(name, mode).objectStore(name);
	}

	/** The ROMs kept here, newest first, without their bytes. */
	async roms() {
		const all = (await done(this.store('roms').getAll())).map(readRom).filter(Boolean);
		return all.sort((a, b) => b.used - a.used).map(({ bytes, ...rest }) => rest);
	}

	async rom(hash) {
		return readRom(await done(this.store('roms').get(hash)));
	}

	/** Keep a ROM (or mark it used now); the oldest go past MAX_ROMS. */
	async addRom({ hash, name, bytes }) {
		await done(this.store('roms', 'readwrite').put({ hash, name, bytes, size: bytes.length, used: Date.now() }));
		const all = await this.roms();
		for (const old of all.slice(MAX_ROMS)) await this.removeRom(old.hash);
	}

	async removeRom(hash) {
		await done(this.store('roms', 'readwrite').delete(hash));
	}

	/** slot → {time} for a ROM's saves. */
	async saves(hash) {
		const rows = await done(this.store('states').index('hash').getAll(hash));
		return new Map(rows.map(readSave).filter(Boolean).map(s => [s.slot, { time: s.time }]));
	}

	async save(hash, slot) {
		return readSave(await done(this.store('states').get(`${hash}/${slot}`)))?.bytes ?? null;
	}

	async putSave(hash, slot, bytes) {
		await done(this.store('states', 'readwrite').put({ id: `${hash}/${slot}`, hash, slot, time: Date.now(), bytes }));
	}
}
