// Everything PeerKit's shared editor uses, as one ES module: vendor/editor.js.
// One bundle keeps a single copy of yjs and @codemirror/state, which both require.

// CRDT and sync
export * as Y from 'yjs';
export * as syncProtocol from 'y-protocols/sync';
export * as awarenessProtocol from 'y-protocols/awareness';
export * as encoding from 'lib0/encoding';
export * as decoding from 'lib0/decoding';
export { IndexeddbPersistence } from 'y-indexeddb';
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
