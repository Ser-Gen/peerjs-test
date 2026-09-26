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
 * setFont(), setDark() and destroy(). The text size comes from the Editor's --editor-font-size.
 */
export class CodeMirrorView {
	constructor(lib, { host, text, lang, awareness, undoManager, selection, wrap, dark }) {
		this.lib = lib;
		this.compartments = { theme: new lib.Compartment(), wrap: new lib.Compartment(), lang: new lib.Compartment() };
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
		];
		this.view = new lib.EditorView({
			parent: host,
			state: lib.EditorState.create({ doc: text.toString(), selection: initial, extensions }),
		});
		if (initial) this.view.dispatch({ effects: lib.EditorView.scrollIntoView(initial.main.head, { y: 'center' }) });
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
		this.view.destroy();
	}
}
