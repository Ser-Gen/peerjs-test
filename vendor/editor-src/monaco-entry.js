// Monaco, the editor of VS Code, for PeerKit's Editor: vendor/monaco.js, with vendor/monaco.css and vendor/monaco.worker.js.
// Only the editor and the languages of app/ui/code.js: no language services (their workers are megabytes). Its features
// are those of `monaco-editor/features/register.all` minus the ones that need a language service or have no use here
// (code actions and lens, colour picker, rename, references, symbols, inlay hints, inline completions, the diff editor,
// GPU rendering, and a few more). No Yjs either: app/tools/editor/monaco-binding.js ties a model to a Y.Text with the
// Yjs of vendor/yjs.js.
import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/features/anchorSelect/register';
import 'monaco-editor/features/bracketMatching/register';
import 'monaco-editor/features/caretOperations/register';
import 'monaco-editor/features/clipboard/register';
import 'monaco-editor/features/codeEditor/register';
import 'monaco-editor/features/codicon/register';
import 'monaco-editor/features/comment/register';
import 'monaco-editor/features/contextmenu/register';
import 'monaco-editor/features/cursorUndo/register';
import 'monaco-editor/features/dnd/register';
import 'monaco-editor/features/dropOrPasteInto/register';
import 'monaco-editor/features/find/register';
import 'monaco-editor/features/folding/register';
import 'monaco-editor/features/fontZoom/register';
import 'monaco-editor/features/format/register';
import 'monaco-editor/features/gotoLine/register';
import 'monaco-editor/features/hover/register';
import 'monaco-editor/features/inPlaceReplace/register';
import 'monaco-editor/features/indentation/register';
import 'monaco-editor/features/inlineProgress/register';
import 'monaco-editor/features/insertFinalNewLine/register';
import 'monaco-editor/features/lineSelection/register';
import 'monaco-editor/features/linesOperations/register';
import 'monaco-editor/features/links/register';
import 'monaco-editor/features/longLinesHelper/register';
import 'monaco-editor/features/multicursor/register';
import 'monaco-editor/features/placeholderText/register';
import 'monaco-editor/features/quickCommand/register';
import 'monaco-editor/features/quickHelp/register';
import 'monaco-editor/features/readOnlyMessage/register';
import 'monaco-editor/features/smartSelect/register';
import 'monaco-editor/features/snippet/register';
import 'monaco-editor/features/stickyScroll/register';
import 'monaco-editor/features/suggest/register';
import 'monaco-editor/features/toggleTabFocusMode/register';
import 'monaco-editor/features/tokenization/register';
import 'monaco-editor/features/unicodeHighlighter/register';
import 'monaco-editor/features/unusualLineTerminators/register';
import 'monaco-editor/features/wordHighlighter/register';
import 'monaco-editor/features/wordOperations/register';
import 'monaco-editor/features/wordPartOperations/register';
import 'monaco-editor/languages/definitions/css/register';
import 'monaco-editor/languages/definitions/html/register';
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/definitions/markdown/register';
import 'monaco-editor/languages/definitions/python/register';
import 'monaco-editor/languages/definitions/typescript/register';

// The editor worker (word suggestions, diffs, links) is vendor/monaco.worker.js next to this file.
self.MonacoEnvironment = {
	getWorker: () => new Worker(new URL('./monaco.worker.js', import.meta.url), { name: 'monaco' }),
};

// JSON's highlighting comes with its language service; a few Monarch rules are enough to colour it.
monaco.languages.register({ id: 'json', extensions: ['.json'], aliases: ['JSON'] });
monaco.languages.setLanguageConfiguration('json', {
	brackets: [['{', '}'], ['[', ']']],
	autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '"', close: '"', notIn: ['string'] }],
});
monaco.languages.setMonarchTokensProvider('json', {
	tokenizer: {
		root: [
			[/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'type'],
			[/"(?:[^"\\]|\\.)*"/, 'string'],
			[/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
			[/\b(?:true|false|null)\b/, 'keyword'],
			[/[{}[\],:]/, 'delimiter'],
		],
	},
});

export { monaco };
