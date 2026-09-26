import { cleanName } from '../../device.js';
import { h } from '../../ui/dom.js';

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const FALLBACK_COLOR = '#0c8599';

/*
 * Ties a Monaco model to a Y.Text both ways, and shows where the others are.
 * The cursor goes in the awareness field y-codemirror.next uses, `cursor: {anchor, head}` as Yjs relative positions,
 * so members in Monaco and members in CodeMirror see each other's cursors. The Y.Text's line breaks are `\n` and the
 * model's EOL is LF, so an offset is the same number in both.
 * Undo is the document's Y.UndoManager (only this device's edits), which tracks this binding as an origin.
 */
export class MonacoBinding {
	constructor({ Y, monaco, editor, model, text, awareness, undoManager }) {
		this.Y = Y;
		this.monaco = monaco;
		this.editor = editor;
		this.model = model;
		this.text = text;
		this.doc = text.doc;
		this.awareness = awareness;
		this.undoManager = undoManager;
		this.applying = false; // edits from the Y.Text going into the model, which must not come back
		this.widgets = new Map(); // client ID → { widget, node, position } of a name above a remote cursor
		this.decorations = editor.createDecorationsCollection();
		this.style = h('style');
		document.head.append(this.style);

		this.resync();
		undoManager.addTrackedOrigin(this);
		this.onText = (event, transaction) => this.fromY(event, transaction);
		text.observe(this.onText);
		this.onAwareness = () => this.renderRemote();
		awareness.on('change', this.onAwareness);
		this.disposables = [
			model.onDidChangeContent(event => this.toY(event)),
			editor.onDidChangeCursorSelection(() => this.sendCursor()),
			editor.onDidFocusEditorText(() => this.sendCursor()),
		];
		this.renderRemote();
	}

	/** Makes the model the same text as the Y.Text. */
	resync() {
		const value = this.text.toString();
		if (this.model.getValue() === value) return;
		this.applying = true;
		try {
			this.model.setValue(value);
		} finally {
			this.applying = false;
		}
	}

	/** A change in the Y.Text (from another member, or undo) goes into the model as one edit per changed stretch. */
	fromY(event, transaction) {
		if (transaction.origin === this) return;
		const { model, monaco } = this;
		const edits = [];
		let at = 0; // in the model's text, which is still the old one
		let after = 0; // in the new text
		let pending = null;
		let caret = null;
		const flush = () => {
			if (!pending) return;
			const start = model.getPositionAt(pending.start);
			const end = model.getPositionAt(pending.end);
			edits.push({ range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: pending.text });
			caret = pending.after + pending.text.length;
			pending = null;
		};
		for (const op of event.delta) {
			if (op.retain) {
				flush();
				at += op.retain;
				after += op.retain;
			} else {
				pending ??= { start: at, end: at, after, text: '' };
				if (typeof op.insert === 'string') {
					pending.text += op.insert;
					after += op.insert.length;
				} else if (op.delete) {
					pending.end += op.delete;
					at += op.delete;
				}
			}
		}
		flush();
		if (!edits.length) return;
		this.applying = true;
		try {
			// Cursors follow the edits by themselves: text typed elsewhere moves them along.
			model.applyEdits(edits);
		} finally {
			this.applying = false;
		}
		if (transaction.origin === this.undoManager && caret !== null) {
			// Undo and redo put the cursor where the text changed, as they do in CodeMirror.
			const position = model.getPositionAt(caret);
			this.editor.setPosition(position);
			this.editor.revealPositionInCenterIfOutsideViewport(position);
		}
		this.renderRemote();
	}

	/** Typing here goes into the Y.Text, the last change first so the offsets of the others stay right. */
	toY(event) {
		if (this.applying) return;
		const { text } = this;
		this.doc.transact(() => {
			for (const change of [...event.changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
				if (change.rangeLength) text.delete(change.rangeOffset, change.rangeLength);
				if (change.text) text.insert(change.rangeOffset, change.text);
			}
		}, this);
	}

	sendCursor() {
		const { Y, editor, model, text, awareness } = this;
		const selection = editor.getSelection();
		const local = awareness.getLocalState();
		if (!selection || !local || !editor.hasTextFocus()) return;
		const anchor = Y.createRelativePositionFromTypeIndex(text, model.getOffsetAt(selection.getSelectionStart()));
		const head = Y.createRelativePositionFromTypeIndex(text, model.getOffsetAt(selection.getPosition()));
		const current = local.cursor;
		if (current?.anchor && current?.head
			&& Y.compareRelativePositions(Y.createRelativePositionFromJSON(current.anchor), anchor)
			&& Y.compareRelativePositions(Y.createRelativePositionFromJSON(current.head), head)) return;
		awareness.setLocalStateField('cursor', { anchor, head });
	}

	/** Where a member's cursor is in this text, or null. Everything in an awareness state is untrusted. */
	remoteCursor(cursor) {
		const { Y, doc, text } = this;
		if (!cursor?.anchor || !cursor?.head) return null;
		try {
			const anchor = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor.anchor), doc);
			const head = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor.head), doc);
			if (anchor?.type !== text || head?.type !== text) return null;
			return { anchor: anchor.index, head: head.index };
		} catch {
			return null;
		}
	}

	/** The others' selections and cursors (decorations), with their names above (content widgets, so text never goes into CSS). */
	renderRemote() {
		const { monaco, model, editor } = this;
		const decorations = [];
		const rules = [];
		const seen = new Set();
		for (const [client, state] of this.awareness.getStates()) {
			if (client === this.doc.clientID || !Number.isSafeInteger(client)) continue;
			const cursor = this.remoteCursor(state?.cursor);
			if (!cursor) continue;
			const color = COLOR_RE.test(state?.user?.color) ? state.user.color : FALLBACK_COLOR;
			const name = cleanName(state?.user?.name) || 'Device';
			const from = model.getPositionAt(Math.min(cursor.anchor, cursor.head));
			const to = model.getPositionAt(Math.max(cursor.anchor, cursor.head));
			const head = model.getPositionAt(cursor.head);
			const forward = cursor.head >= cursor.anchor;
			const cls = `peerkit-y${client}`;
			decorations.push({
				range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column),
				options: {
					className: from.equals(to) ? null : `${cls}-sel`,
					[forward ? 'afterContentClassName' : 'beforeContentClassName']: `peerkit-yhead ${cls}-head`,
					showIfCollapsed: true,
					stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
				},
			});
			rules.push(`.${cls}-sel { background-color: ${color}33; }`, `.${cls}-head { border-left-color: ${color}; }`);
			seen.add(client);
			this.showName(client, name, color, head);
		}
		for (const client of [...this.widgets.keys()].filter(client => !seen.has(client))) {
			editor.removeContentWidget(this.widgets.get(client).widget);
			this.widgets.delete(client);
		}
		this.decorations.set(decorations);
		this.style.textContent = rules.join('\n');
	}

	showName(client, name, color, position) {
		const { editor, monaco } = this;
		let entry = this.widgets.get(client);
		if (!entry) {
			const node = h('div', { class: 'peerkit-yname' });
			entry = { node, position };
			entry.widget = {
				getId: () => `peerkit.cursor.${client}`,
				getDomNode: () => node,
				getPosition: () => ({
					position: entry.position,
					preference: [monaco.editor.ContentWidgetPositionPreference.ABOVE, monaco.editor.ContentWidgetPositionPreference.BELOW],
				}),
			};
			this.widgets.set(client, entry);
			editor.addContentWidget(entry.widget);
		}
		entry.node.textContent = name;
		entry.node.style.backgroundColor = color;
		entry.position = position;
		editor.layoutContentWidget(entry.widget);
	}

	destroy() {
		this.disposables.forEach(disposable => disposable.dispose());
		this.text.unobserve(this.onText);
		this.awareness.off('change', this.onAwareness);
		this.undoManager.removeTrackedOrigin(this);
		for (const { widget } of this.widgets.values()) this.editor.removeContentWidget(widget);
		this.widgets.clear();
		this.decorations.clear();
		this.style.remove();
	}
}
