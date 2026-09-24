// CodeMirror setup shared by the Editor and the chat's file viewer. `lib` is vendor/editor.js.

export const LANGS = {
	text: { label: 'Plain text', ext: 'txt', prose: true },
	markdown: { label: 'Markdown', ext: 'md', prose: true },
	javascript: { label: 'JavaScript', ext: 'js' },
	typescript: { label: 'TypeScript', ext: 'ts' },
	json: { label: 'JSON', ext: 'json' },
	html: { label: 'HTML', ext: 'html' },
	css: { label: 'CSS', ext: 'css' },
	python: { label: 'Python', ext: 'py' },
};

export const EXTENSIONS = {
	txt: 'text', text: 'text', log: 'text',
	md: 'markdown', markdown: 'markdown',
	js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
	ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
	json: 'json', html: 'html', htm: 'html', svg: 'html', xml: 'html', css: 'css', py: 'python',
};

export const extensionOf = name => /\.([a-z0-9]+)$/i.exec(name ?? '')?.[1].toLowerCase() ?? '';

/** The language key for a file name; plain text when the extension isn't one of LANGS. */
export const langOf = name => EXTENSIONS[extensionOf(name)] ?? 'text';

/** Syntax for a language, and its indent. */
export function languageSupport(lib, lang) {
	const language = {
		text: null,
		markdown: () => lib.markdown(),
		javascript: () => lib.javascript({ jsx: true }),
		typescript: () => lib.javascript({ typescript: true }),
		json: () => lib.json(),
		html: () => lib.html(),
		css: () => lib.css(),
		python: () => lib.python(),
	}[lang];
	return [language ? language() : [], lib.indentUnit.of(lang === 'python' ? '    ' : '  ')];
}

export const darkScheme = () => matchMedia('(prefers-color-scheme: dark)').matches;

/** Syntax colours for the light or the dark theme. */
export function highlighting(lib, dark) {
	return [lib.EditorView.darkTheme.of(dark), lib.syntaxHighlighting(dark ? lib.oneDarkHighlightStyle : lib.defaultHighlightStyle)];
}

/** The app's look for CodeMirror: its colours and sizes from styles.css. */
export function codeTheme(lib) {
	return lib.EditorView.theme({
		'&': { height: '100%', backgroundColor: 'var(--surface)', color: 'var(--text)', fontSize: 'var(--editor-font-size)' },
		'&.cm-focused': { outline: 'none' },
		'.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', lineHeight: '1.5', overscrollBehavior: 'contain' },
		'.cm-content': { paddingBlock: '1.25rem' }, // room for another member's name label on the first line
		'.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--muted)', borderRight: '1px solid var(--border)' },
		'.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 7%, transparent)' },
		'.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--accent) 14%, transparent)' },
		'.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
		'&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
			backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent)',
		},
		'.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--text)' },
		'.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
		'.cm-search': { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.35rem', padding: '0.5rem', fontFamily: 'inherit' },
		'.cm-search br': { flexBasis: '100%', height: 0 },
		'.cm-textfield': {
			minHeight: '36px',
			margin: 0,
			padding: '0 0.5rem',
			border: '1px solid var(--border)',
			borderRadius: '8px',
			backgroundColor: 'var(--bg)',
			color: 'var(--text)',
			fontSize: '16px', // below 16px mobile browsers zoom on focus
		},
		'.cm-button': {
			minHeight: '36px',
			margin: 0,
			padding: '0 0.6rem',
			border: '1px solid var(--border)',
			borderRadius: '8px',
			backgroundImage: 'none',
			backgroundColor: 'var(--surface)',
			color: 'var(--text)',
			fontSize: '0.85rem',
		},
		'.cm-search label': { display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.85rem' },
		'.cm-search button[name=close]': { width: '36px', height: '36px', fontSize: '1.25rem', color: 'var(--muted)' },
		// y-codemirror.next shows names only on hover, which a phone doesn't have.
		'.cm-ySelectionInfo': {
			opacity: 1,
			top: '-1.4em',
			padding: '0 0.3em',
			borderRadius: '4px 4px 4px 0',
			fontFamily: 'system-ui, sans-serif',
			fontSize: '0.7rem',
			lineHeight: 1.5,
			whiteSpace: 'nowrap',
		},
	});
}
