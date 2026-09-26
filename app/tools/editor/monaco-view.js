import { loadStylesheet } from '../../ui/dom.js';
import { MonacoBinding } from './monaco-binding.js';

let loading = null;

/** vendor/monaco.js (3.5 MB) and its stylesheet, fetched the first time a document opens in Monaco. */
export function loadMonaco() {
	loading ??= Promise.all([import('../../../vendor/monaco.js'), loadStylesheet(new URL('../../../vendor/monaco.css', import.meta.url).href)])
		.then(([lib]) => lib.monaco)
		.catch(err => {
			loading = null;
			throw err;
		});
	return loading;
}

// The languages of LANGS (app/ui/code.js) by Monaco's names.
const LANGUAGE = {
	text: 'plaintext',
	markdown: 'markdown',
	javascript: 'javascript',
	typescript: 'typescript',
	json: 'json',
	html: 'html',
	css: 'css',
	python: 'python',
};
const HEX = /^#[0-9a-f]{6}$/i;

/** The app's colours (styles.css) as Monaco's theme. A Monaco theme is global: this sets it for every editor. */
function applyTheme(monaco, dark) {
	const css = getComputedStyle(document.documentElement);
	const colour = (name, alpha = '') => {
		const value = css.getPropertyValue(name).trim();
		return HEX.test(value) ? `${value}${alpha}` : null;
	};
	const colors = Object.fromEntries(Object.entries({
		'editor.background': colour('--surface'),
		'editor.foreground': colour('--text'),
		'editorGutter.background': colour('--surface'),
		'editorLineNumber.foreground': colour('--muted'),
		'editorLineNumber.activeForeground': colour('--text'),
		'editorCursor.foreground': colour('--text'),
		'editor.lineHighlightBackground': colour('--accent', '12'),
		'editor.lineHighlightBorder': colour('--accent', '00'),
		'editor.selectionBackground': colour('--accent', '47'),
		'editorWidget.background': colour('--surface'),
		'editorWidget.border': colour('--border'),
		'input.background': colour('--bg'),
		'input.border': colour('--border'),
		focusBorder: colour('--accent'),
	}).filter(([, value]) => value));
	monaco.editor.defineTheme('peerkit', { base: dark ? 'vs-dark' : 'vs', inherit: true, rules: [], colors });
	monaco.editor.setTheme('peerkit');
}

/** One document in Monaco; the same methods as CodeMirrorView (cm-view.js). */
export class MonacoView {
	constructor(monaco, { Y, host, text, lang, awareness, undoManager, selection, wrap, fontSize, dark }) {
		this.monaco = monaco;
		applyTheme(monaco, dark);
		this.model = monaco.editor.createModel(text.toString(), LANGUAGE[lang]);
		this.model.setEOL(monaco.editor.EndOfLineSequence.LF);
		this.setIndent(lang);
		this.editor = monaco.editor.create(host, {
			model: this.model,
			theme: 'peerkit',
			automaticLayout: true,
			fontSize,
			fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
			lineHeight: 1.5,
			wordWrap: wrap ? 'on' : 'off',
			minimap: { enabled: false }, // the Editor is often a narrow panel
			scrollBeyondLastLine: false,
			padding: { top: 20 }, // room for another member's name above the first line
			fixedOverflowWidgets: true, // suggestions and hovers aren't cut off at the panel's edge
			wordBasedSuggestions: 'currentDocument',
		});
		this.binding = new MonacoBinding({ Y, monaco, editor: this.editor, model: this.model, text, awareness, undoManager });
		// The document's Y.UndoManager instead of Monaco's own undo, which would also undo the others' edits.
		const { KeyMod, KeyCode } = monaco;
		this.editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyZ, () => undoManager.undo());
		this.editor.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyZ, () => undoManager.redo());
		this.editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyY, () => undoManager.redo());
		if (selection) {
			const length = this.model.getValueLength();
			const anchor = this.model.getPositionAt(Math.min(selection.anchor, length));
			const head = this.model.getPositionAt(Math.min(selection.head, length));
			this.editor.setSelection(monaco.Selection.fromPositions(anchor, head));
			this.editor.revealPositionInCenter(head);
		}
	}

	setIndent(lang) {
		this.model.updateOptions({ tabSize: lang === 'python' ? 4 : 2, insertSpaces: true });
	}

	selection() {
		const selection = this.editor.getSelection();
		if (!selection) return { anchor: 0, head: 0 };
		return { anchor: this.model.getOffsetAt(selection.getSelectionStart()), head: this.model.getOffsetAt(selection.getPosition()) };
	}

	focus() {
		this.editor.focus();
	}

	blur() {
		if (this.editor.getContainerDomNode().contains(document.activeElement)) document.activeElement.blur();
	}

	indent() {
		this.editor.trigger('keyboard', 'editor.action.indentLines', null);
	}

	outdent() {
		this.editor.trigger('keyboard', 'editor.action.outdentLines', null);
	}

	toggleSearch() {
		const find = this.editor.getContribution('editor.contrib.findController');
		if (find?.getState().isRevealed) {
			find.closeFindWidget();
			return false;
		}
		this.editor.getAction('actions.find')?.run();
		return true;
	}

	setLang(lang) {
		this.monaco.editor.setModelLanguage(this.model, LANGUAGE[lang]);
		this.setIndent(lang);
	}

	setWrap(wrap) {
		this.editor.updateOptions({ wordWrap: wrap ? 'on' : 'off' });
	}

	setFont(fontSize) {
		this.editor.updateOptions({ fontSize });
	}

	setDark(dark) {
		applyTheme(this.monaco, dark);
	}

	destroy() {
		this.binding.destroy();
		this.editor.dispose();
		this.model.dispose();
	}
}
