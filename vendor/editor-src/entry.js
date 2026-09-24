// Everything PeerKit's shared editor uses, as one ES module: vendor/editor.js.
// One bundle keeps a single copy of @codemirror/state, which breaks with two. Yjs, which breaks the same way,
// is not in it: it comes from vendor/yjs.js (yjs-entry.js), which the chat loads on its own.

// CRDT and sync, from vendor/yjs.js next to this bundle (build.mjs leaves './yjs.js' and 'yjs' as imports)
export { Y, syncProtocol, awarenessProtocol, encoding, decoding, IndexeddbPersistence } from './yjs.js';
export { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';

// CodeMirror
export { Compartment, EditorSelection, EditorState, Prec } from '@codemirror/state';
export {
	EditorView,
	crosshairCursor,
	drawSelection,
	dropCursor,
	highlightActiveLine,
	highlightActiveLineGutter,
	highlightSpecialChars,
	keymap,
	lineNumbers,
	rectangularSelection,
} from '@codemirror/view';
export { indentLess, indentMore, indentWithTab } from '@codemirror/commands';
export { closeSearchPanel, highlightSelectionMatches, openSearchPanel, search, searchPanelOpen } from '@codemirror/search';
export { bracketMatching, defaultHighlightStyle, foldGutter, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
export { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
export { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
export { vscodeKeymap } from '@replit/codemirror-vscode-keymap';

// Languages
export { css } from '@codemirror/lang-css';
export { html } from '@codemirror/lang-html';
export { javascript } from '@codemirror/lang-javascript';
export { json } from '@codemirror/lang-json';
export { markdown } from '@codemirror/lang-markdown';
export { python } from '@codemirror/lang-python';
