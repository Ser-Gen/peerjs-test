// Runs the Node tests. Usage:
//   node test/run.mjs                 every test once
//   node test/run.mjs room            one test by name (room | editor-sync | voice | pwa | vendor | app | start | desktop | editor | monaco | chat | whiteboard)
//   node test/run.mjs room --times 20 repeat it, which is how the random anchor handover is checked
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const hasModules = existsSync(new URL('node_modules', import.meta.url));

const TESTS = [
	{ name: 'room', file: 'room-test.mjs', args: [], about: 'rooms, anchor handover and links on a fake network' },
	{ name: 'editor-sync', file: 'editor-sync-test.mjs', args: [], about: 'Yjs sync and forwarding between 3–4 members' },
	{ name: 'voice', file: 'voice-test.mjs', args: [], about: 'room voice: who dials, listeners, mute, links that drop' },
	{ name: 'pwa', file: 'pwa-test.mjs', args: [], about: 'the manifest, the service worker and the Android share' },
	{ name: 'vendor', file: 'vendor-test.mjs', args: [], about: 'the vendored bundles: one Yjs, Monaco without one, pdf.js reading a PDF' },
	{ name: 'app', file: 'dom/app-test.mjs', args: ['room'], jsdom: true, about: 'the whole app in a room, in jsdom' },
	{ name: 'start', file: 'dom/app-test.mjs', args: ['start'], jsdom: true, about: 'the start screen: codes, links, recent rooms' },
	{ name: 'desktop', file: 'dom/app-test.mjs', args: ['desktop'], jsdom: true, about: 'the desktop layout: panels, float, maximize, back to tabs' },
	{ name: 'editor', file: 'dom/editor-test.mjs', args: [], jsdom: true, about: 'the Editor tool with two members, in jsdom' },
	{ name: 'monaco', file: 'dom/monaco-test.mjs', args: [], jsdom: true, about: 'the Editor in Monaco, with a member in CodeMirror, and switching between them' },
	{ name: 'chat', file: 'dom/chat-test.mjs', args: [], jsdom: true, about: 'the Chat: history, kept files, the viewer, the storage limit' },
	{ name: 'whiteboard', file: 'dom/whiteboard-test.mjs', args: [], jsdom: true, about: 'the Whiteboard: drawing together, undo, images from the clipboard, export' },
];

const argv = process.argv.slice(2);
const timesAt = argv.findIndex(a => a === '--times');
const times = timesAt === -1 ? 1 : Number(argv[timesAt + 1] ?? 1);
const wanted = argv.filter((a, i) => !a.startsWith('--') && (timesAt === -1 || i !== timesAt + 1));
const chosen = wanted.length ? TESTS.filter(t => wanted.includes(t.name)) : TESTS;
if (!chosen.length) {
	console.error(`Unknown test. Names: ${TESTS.map(t => t.name).join(', ')}`);
	process.exit(2);
}

const run = (test, run) => new Promise(resolve => {
	const child = spawn(process.execPath, [here + test.file, ...test.args], { stdio: ['ignore', 'pipe', 'pipe'] });
	let out = '';
	child.stdout.on('data', chunk => (out += chunk));
	child.stderr.on('data', chunk => (out += chunk));
	child.on('close', code => {
		const checks = (out.match(/^ok  /gm) ?? []).length;
		const label = `${test.name}${run ? ` #${run}` : ''}`;
		if (code === 0) console.log(`ok   ${label} — ${checks} checks · ${test.about}`);
		else {
			console.log(`FAIL ${label}`);
			console.log(out.split('\n').filter(line => !line.startsWith('ok  ')).join('\n').trim());
		}
		resolve(code === 0);
	});
});

let failed = 0;
let skipped = 0;
for (const test of chosen) {
	if (test.jsdom && !hasModules) {
		console.log(`skip ${test.name} — run "npm install" in test/ first (jsdom, fake-indexeddb)`);
		skipped++;
		continue;
	}
	for (let i = 1; i <= times; i++) if (!(await run(test, times > 1 ? i : 0))) failed++;
}
console.log(failed ? `\n${failed} FAILED` : `\nall passed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed ? 1 : 0);
