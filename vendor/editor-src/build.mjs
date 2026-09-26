// Builds ../yjs.js and ../editor.js (vendor/). Run `npm ci`, then `npm run build`.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));

// The editor bundle gets Yjs from vendor/yjs.js next to it, never a copy of its own.
const yjsOutside = {
	name: 'yjs-outside',
	setup(b) {
		b.onResolve({ filter: /^(yjs|\.\/yjs\.js)$/ }, () => ({ path: './yjs.js', external: true }));
	},
};

/** Name, version and licence of every package that ended up in a bundle. */
function contents(metafile) {
	const names = new Set();
	for (const input of Object.keys(metafile.inputs)) {
		const match = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
		if (match) names.add(match[1]);
	}
	return [...names].sort().map(name => {
		const pkg = lock.packages[`node_modules/${name}`];
		return `${name}@${pkg.version} (${pkg.license ?? 'see package'})`;
	});
}

async function bundle({ entry, outfile, title, plugins = [], format = 'esm', loader = {} }) {
	const options = { entryPoints: [entry], bundle: true, format, target: 'es2020', plugins, loader, logLevel: 'error' };
	const { metafile } = await build({ ...options, outfile, write: false, metafile: true });
	const list = contents(metafile);
	await build({
		...options,
		outfile,
		minify: true,
		legalComments: 'eof',
		banner: Object.fromEntries(['js', 'css'].map(kind => [kind, `/*\n * ${title}, built from vendor/editor-src (see vendor/README.md). Contains:\n * ${list.join('\n * ')}\n */`])),
	});
	console.log(`built ${outfile} from ${list.length} packages`);
}

await bundle({ entry: 'yjs-entry.js', outfile: '../yjs.js', title: 'PeerKit shared data bundle (Yjs)' });
await bundle({ entry: 'entry.js', outfile: '../editor.js', title: 'PeerKit shared editor bundle; Yjs comes from ./yjs.js', plugins: [yjsOutside] });
// Monaco's stylesheet comes out next to it as ../monaco.css, with its icon font inside.
await bundle({ entry: 'monaco-entry.js', outfile: '../monaco.js', title: 'PeerKit Monaco bundle (the Editor with Monaco chosen)', loader: { '.ttf': 'dataurl' } });
await bundle({ entry: 'monaco-worker-entry.js', outfile: '../monaco.worker.js', title: 'PeerKit Monaco editor worker', format: 'iife' });
