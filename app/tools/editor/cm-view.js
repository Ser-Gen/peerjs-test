import { LANGS, codeTheme, highlighting, languageSupport } from '../../ui/code.js';

let loading = null;

/** vendor/editor.js (0.7 MB), fetched the first time a document opens in CodeMirror. */
export function loadCodeMirror() {
	loading ??= import('../../../vendor/editor.js').catch(err => {
		loading = null;
		throw err;
	});
	return loading;
}

function languageExtensions(lib, lang) {
	// Autocorrect and swipe typing help prose; in code they mangle identifiers.
	const attrs = LANGS[lang].prose
		? { spellcheck: 'true', autocorrect: 'on', autocapitalize: 'sentences', writingsuggestions: 'true' }
		: { spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' };
	return [languageSupport(lib, lang), lib.EditorView.contentAttributes.of(attrs)];
}

/**
 * One document in CodeMirror. Like MonacoView, it takes { host, text, lang, awareness, undoManager, selection, wrap,
 * fontSize, dark } and has selection(), focus(), blur(), indent(), outdent(), toggleSearch(), setLang(), setWrap(),
 * setFont(), setDark(), destroy(), and for showing where the others are: visibleLines(), lineSpan(), lineCount(),
 * revealLine() and onView(). Lines are counted from 0. The text size comes from the Editor's --editor-font-size.
 */
export class CodeMirrorView {
	constructor(lib, { host, text, lang, awareness, undoManager, selection, wrap, dark }) {
		this.lib = lib;
		this.compartments = { theme: new lib.Compartment(), wrap: new lib.Compartment(), lang: new lib.Compartment() };
		this.viewListeners = new Set();
		const { compartments } = this;
		const length = text.length;
		const initial = selection ? lib.EditorSelection.single(Math.min(selection.anchor, length), Math.min(selection.head, length)) : undefined;
		const extensions = [
			lib.lineNumbers(),
			lib.highlightActiveLineGutter(),
			lib.highlightSpecialChars(),
			lib.foldGutter(),
			lib.drawSelection(),
			lib.dropCursor(),
			lib.EditorState.allowMultipleSelections.of(true),
			lib.indentOnInput(),
			lib.bracketMatching(),
			lib.closeBrackets(),
			lib.rectangularSelection(),
			lib.crosshairCursor(),
			lib.highlightActiveLine(),
			lib.highlightSelectionMatches(),
			lib.search({ top: true }), // away from the on-screen keyboard
			compartments.theme.of(highlighting(lib, dark)),
			compartments.wrap.of(wrap ? lib.EditorView.lineWrapping : []),
			compartments.lang.of(languageExtensions(lib, lang)),
			// Collaborative undo instead of CodeMirror's history, which would also undo the others' edits.
			lib.Prec.high(lib.keymap.of([...lib.yUndoManagerKeymap, ...lib.closeBracketsKeymap])),
			lib.keymap.of([...lib.vscodeKeymap, lib.indentWithTab]),
			lib.yCollab(text, awareness, { undoManager }),
			codeTheme(lib),
			lib.EditorView.updateListener.of(update => {
				if (update.docChanged || update.viewportChanged || update.geometryChanged) this.viewChanged();
			}),
		];
		this.view = new lib.EditorView({
			parent: host,
			state: lib.EditorState.create({ doc: text.toString(), selection: initial, extensions }),
		});
		if (initial) this.view.dispatch({ effects: lib.EditorView.scrollIntoView(initial.main.head, { y: 'center' }) });
		this.onScroll = () => this.viewChanged();
		this.view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
	}

	viewChanged() {
		for (const fn of [...this.viewListeners]) fn();
	}

	/** Called when what is in view may have moved: a scroll, a resize, an edit. Returns an unsubscribe function. */
	onView(fn) {
		this.viewListeners.add(fn);
		return () => this.viewListeners.delete(fn);
	}

	/** The first and last line in view. */
	visibleLines() {
		const { view } = this;
		const { doc } = view.state;
		const rect = view.scrollDOM.getBoundingClientRect();
		const top = view.lineBlockAtHeight(rect.top - view.documentTop);
		const bottom = view.lineBlockAtHeight(rect.bottom - view.documentTop);
		return { top: doc.lineAt(top.from).number - 1, bottom: doc.lineAt(bottom.to).number - 1 };
	}

	/** Where a line is on the screen (client px, top and bottom), in view or not. */
	lineSpan(line) {
		const { view } = this;
		const { doc } = view.state;
		const block = view.lineBlockAt(doc.line(Math.min(Math.max(line, 0), doc.lines - 1) + 1).from);
		return { top: view.documentTop + block.top, bottom: view.documentTop + block.bottom };
	}

	lineCount() {
		return this.view.state.doc.lines;
	}

	/** Scroll a line to the top of the view. */
	revealLine(line) {
		const { doc } = this.view.state;
		const pos = doc.line(Math.min(Math.max(line, 0), doc.lines - 1) + 1).from;
		this.view.dispatch({ effects: this.lib.EditorView.scrollIntoView(pos, { y: 'start', yMargin: 24 }) });
	}

	selection() {
		const { anchor, head } = this.view.state.selection.main;
		return { anchor, head };
	}

	focus() {
		this.view.focus();
	}

	blur() {
		this.view.contentDOM.blur();
	}

	indent() {
		this.lib.indentMore(this.view);
	}

	outdent() {
		this.lib.indentLess(this.view);
	}

	/** Opens or closes the search panel; true when it is open now. */
	toggleSearch() {
		const { view, lib } = this;
		if (lib.searchPanelOpen(view.state)) {
			lib.closeSearchPanel(view);
			return false;
		}
		lib.openSearchPanel(view);
		return true;
	}

	setLang(lang) {
		this.view.dispatch({ effects: this.compartments.lang.reconfigure(languageExtensions(this.lib, lang)) });
	}

	setWrap(wrap) {
		this.view.dispatch({ effects: this.compartments.wrap.reconfigure(wrap ? this.lib.EditorView.lineWrapping : []) });
	}

	setFont() {
		this.view.requestMeasure();
	}

	setDark(dark) {
		this.view.dispatch({ effects: this.compartments.theme.reconfigure(highlighting(this.lib, dark)) });
	}

	destroy() {
		this.viewListeners.clear();
		this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
		this.view.destroy();
	}
}
