// app/tools/editor/provider.js in rooms: several members, links that come and go, forwarding for unlinked pairs.
globalThis.window = globalThis;
const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, ''); // the repo root
const lib = await import(`${ROOT}/vendor/editor.js`);
const { DocProvider } = await import(`${ROOT}/app/tools/editor/provider.js`);
const { Emitter } = await import(`${ROOT}/app/emitter.js`);

const MTU = 16300;
let failures = 0;
function check(name, ok, extra = '') {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
	if (!ok) failures++;
}

const wire = []; // [from, to, json]
let maxBytes = 0;

class FakeRoom extends Emitter {
	constructor(name) {
		super();
		this.self = { peerId: `pk-m-${name}`, name, color: '#123456' };
		this.linked = new Map(); // peerId → FakeRoom
	}
	get members() {
		return [...this.linked.values()].map(room => ({ ...room.self }));
	}
	member(peerId) {
		const room = this.linked.get(peerId);
		return room ? { ...room.self } : null;
	}
	send(ch, msg, to = null) {
		const targets = to ? [to].filter(id => this.linked.has(id)) : [...this.linked.keys()];
		for (const id of targets) {
			const json = JSON.stringify({ ...msg, ch });
			if (json.length >= MTU) throw new Error(`message too big: ${json.length}`);
			maxBytes = Math.max(maxBytes, json.length);
			wire.push([this, this.linked.get(id), json]);
		}
		return targets.length;
	}
	controlBuffered() {
		return 0;
	}
	isLinked(a, b) {
		const find = id => [this, ...this.linked.values()].find(room => room.self.peerId === id) ?? all.get(id);
		return Boolean(find(a)?.linked.has(b));
	}
}
const all = new Map();

function member(name) {
	const room = new FakeRoom(name);
	all.set(room.self.peerId, room);
	const doc = new lib.Y.Doc();
	const awareness = new lib.awarenessProtocol.Awareness(doc);
	awareness.setLocalState({ user: { name }, doc: null });
	const provider = new DocProvider({ lib, room, doc, awareness });
	return { name, room, doc, awareness, provider, docs: doc.getMap('docs') };
}

function link(a, b) {
	a.room.linked.set(b.room.self.peerId, b.room);
	b.room.linked.set(a.room.self.peerId, a.room);
	a.room.emit('link-up', b.room.self);
	b.room.emit('link-up', a.room.self);
}

function unlink(a, b) {
	a.room.linked.delete(b.room.self.peerId);
	b.room.linked.delete(a.room.self.peerId);
	for (let i = wire.length - 1; i >= 0; i--) {
		const [from, to] = wire[i];
		if ((from === a.room && to === b.room) || (from === b.room && to === a.room)) wire.splice(i, 1);
	}
	a.room.emit('link-down', b.room.self);
	b.room.emit('link-down', a.room.self);
	for (const side of [a, b]) for (const other of side.room.linked.values()) other.emit('links', { ...side.room.self });
}

function deliver() {
	let count = 0;
	while (wire.length) {
		const [from, to, json] = wire.shift();
		if (!to.linked.has(from.self.peerId)) continue;
		const msg = JSON.parse(json);
		to.emit(`msg:${msg.ch}`, msg, { ...from.self });
		count++;
	}
	return count;
}

function addDoc(s, id, content) {
	s.doc.transact(() => {
		const entry = new lib.Y.Map();
		s.docs.set(id, entry);
		entry.set('name', id);
		const text = new lib.Y.Text();
		entry.set('text', text);
		text.insert(0, content);
	});
}
const textOf = (s, id) => s.docs.get(id)?.get('text')?.toString();
const others = s => [...s.awareness.getStates().entries()].filter(([id]) => id !== s.doc.clientID).map(([, st]) => st.user?.name).sort().join(',');

// 1. Three members, full mesh.
const a = member('A');
const b = member('B');
const c = member('C');
addDoc(a, 'notes', 'from A');
link(a, b);
link(b, c);
link(a, c);
deliver();
check('a document reaches every member', textOf(b, 'notes') === 'from A' && textOf(c, 'notes') === 'from A');
check('everyone sees the other two cursors', others(a) === 'B,C' && others(b) === 'A,C' && others(c) === 'A,B', `${others(a)} | ${others(b)} | ${others(c)}`);
b.docs.get('notes').get('text').insert(0, 'B ');
wire.length = wire.length; // keep
const before = wire.length;
deliver();
check('in a full mesh an update is not forwarded', before === 2, `${before} messages for one keystroke`);
check('and reaches both', textOf(a, 'notes') === 'B from A' && textOf(c, 'notes') === 'B from A');

// 2. A and C lose their direct link; B forwards.
unlink(a, c);
deliver();
check('cursors still arrive through B', others(a) === 'B,C' && others(c) === 'A,B', `${others(a)} | ${others(c)}`);
a.docs.get('notes').get('text').insert(a.docs.get('notes').get('text').length, ' +A');
deliver();
check('typing on A reaches C through B', textOf(c, 'notes') === 'B from A +A');
c.awareness.setLocalStateField('doc', 'notes');
deliver();
check('a cursor change on C reaches A through B', a.awareness.getStates().get(c.doc.clientID)?.doc === 'notes');

// 3. B leaves: A and C are cut off from each other, their states go.
unlink(a, b);
unlink(b, c);
deliver();
check('states heard only through a gone link are removed', others(a) === '' && others(c) === '', `${others(a)} | ${others(c)}`);

// 4. Edits apart, then everyone links again.
a.docs.get('notes').get('text').insert(0, '[A] ');
c.docs.get('notes').get('text').insert(c.docs.get('notes').get('text').length, ' [C]');
addDoc(b, 'b-only', 'written alone');
link(a, b);
link(b, c);
link(a, c);
deliver();
const t = textOf(a, 'notes');
check('edits made apart merge on all three', t === textOf(b, 'notes') && t === textOf(c, 'notes') && t.startsWith('[A] ') && t.endsWith(' [C]'), JSON.stringify(t));
check('a document made alone reaches everyone', textOf(a, 'b-only') === 'written alone' && textOf(c, 'b-only') === 'written alone');
check('cursors are back after relinking', others(a) === 'B,C' && others(c) === 'A,B');

// 5. A newcomer gets everything, including a 1 MB document, in parts under the message limit.
const big = 'The quick brown fox jumps over the lazy dog ✓\n'.repeat(22000);
addDoc(a, 'big', big);
deliver();
const d = member('D');
maxBytes = 0;
link(d, a);
link(d, b);
link(d, c);
const sent = deliver();
check('a newcomer gets all documents', textOf(d, 'big') === big && textOf(d, 'notes') === t, `${sent} messages, largest ${maxBytes} bytes`);
check('every message stays under the peerjs JSON limit', maxBytes < MTU);

// 6. Destroying a provider tells the others the cursor is gone.
d.provider.destroy();
deliver();
check('a destroyed provider removes its cursor on the others', !a.awareness.getStates().has(d.doc.clientID));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
