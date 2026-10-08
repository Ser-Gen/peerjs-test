import { CH } from './protocol.js';
import { Emitter } from './emitter.js';

const SEND_DELAY = 250; // ms: flicking through tabs sends only where it stops
const TOOL_ID = /^[a-z][a-z0-9-]{0,23}$/;

/*
 * Which tool each member is looking at, for the marks on the tabs (app/ui/layout.js) and the room bar.
 *
 * Protocol (ch: 'presence'):
 *   here {tool}   the tool in front on the sender's screen (the selected tab, or the active panel on a wide
 *                 screen), null while its page is hidden. Sent on every change and on every link up.
 * A tool id this version doesn't have is kept and simply not shown, so an older device ignores a newer tool.
 */
export class Presence extends Emitter {
	/**
	 * @param {object} room
	 * @param {() => string | null} current the tool in front on this device
	 */
	constructor(room, current) {
		super();
		this.room = room;
		this.current = current;
		this.sent = undefined; // what the others were last told
		this.timer = null;
		this.where = new Map(); // peer ID → tool id | null
		this.onVisibility = () => this.update(true);
		document.addEventListener('visibilitychange', this.onVisibility);
		this.unsubscribe = [
			room.on(`msg:${CH.PRESENCE}`, (msg, member) => this.onMessage(msg, member)),
			room.on('link-up', member => this.room.send(CH.PRESENCE, { type: 'here', tool: this.here() }, member.peerId)),
			room.on('link-down', member => {
				if (this.where.delete(member.peerId)) this.emit('change');
			}),
		];
	}

	destroy() {
		clearTimeout(this.timer);
		document.removeEventListener('visibilitychange', this.onVisibility);
		this.unsubscribe.forEach(fn => fn());
	}

	/** What this device would say now. */
	here() {
		if (document.visibilityState === 'hidden') return null;
		return this.current() ?? null;
	}

	/** The tool in front may have changed; `now` skips the wait (the page was hidden: say so before it sleeps). */
	update(now = false) {
		clearTimeout(this.timer);
		this.timer = null;
		const send = () => {
			const tool = this.here();
			if (tool === this.sent) return;
			this.sent = tool;
			this.room.send(CH.PRESENCE, { type: 'here', tool });
		};
		if (now) send();
		else this.timer = setTimeout(send, SEND_DELAY);
	}

	onMessage(msg, member) {
		if (msg?.type !== 'here') return;
		const tool = typeof msg.tool === 'string' && TOOL_ID.test(msg.tool) ? msg.tool : null;
		if (this.where.get(member.peerId) === tool && this.where.has(member.peerId)) return;
		this.where.set(member.peerId, tool);
		this.emit('change');
	}

	/** The tool a member is looking at, or null (not known yet, or its page is hidden). */
	toolOf(peerId) {
		return this.where.get(peerId) ?? null;
	}

	/** Tool id → the members looking at it, in room order. */
	byTool() {
		const out = new Map();
		for (const member of this.room.members) {
			const tool = this.toolOf(member.peerId);
			if (!tool) continue;
			if (!out.has(tool)) out.set(tool, []);
			out.get(tool).push(member);
		}
		return out;
	}
}
