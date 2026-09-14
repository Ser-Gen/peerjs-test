// Builds ../editor.js (vendor/editor.js). Run `npm ci`, then `npm run build`.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

// Name, version and licence of every package that ends up in the bundle, from the lock file.
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const bundled = Object.entries(lock.packages)
	.filter(([path, pkg]) => path.startsWith('node_modules/') && !pkg.dev)
	.map(([path, pkg]) => `${path.slice('node_modules/'.length)}@${pkg.version} (${pkg.license ?? 'see package'})`)
	.sort();

await build({
	entryPoints: ['entry.js'],
	outfile: '../editor.js',
	bundle: true,
	format: 'esm',
	minify: true,
	target: 'es2020',
	legalComments: 'eof',
	banner: { js: `/*\n * PeerKit shared editor bundle, built from vendor/editor-src (see vendor/README.md). Contains:\n * ${bundled.join('\n * ')}\n */` },
});
console.log(`built ../editor.js from ${bundled.length} packages`);
