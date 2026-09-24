// The vendored bundles load and fit together: one Yjs for the chat and the editor, and pdf.js reading a PDF.
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, ''); // the repo root

let failures = 0;
function check(name, ok, extra = '') {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
	if (!ok) failures++;
}

// --- vendor/yjs.js and vendor/editor.js ---

const yjs = await import(`${ROOT}/vendor/yjs.js`);
const editor = await import(`${ROOT}/vendor/editor.js`);
check('the editor bundle hands out the Yjs of vendor/yjs.js', editor.Y === yjs.Y && editor.Y.Doc === yjs.Doc && editor.syncProtocol === yjs.syncProtocol);
// Yjs warns when it is loaded twice; only the file that carries it has the warning in it.
const twice = 'Yjs was already imported';
check('and carries no copy of its own', readFileSync(`${ROOT}/vendor/yjs.js`, 'utf8').includes(twice) && !readFileSync(`${ROOT}/vendor/editor.js`, 'utf8').includes(twice));
const doc = new yjs.Y.Doc();
doc.getText('t').insert(0, 'hi');
const copy = new editor.Y.Doc();
editor.Y.applyUpdate(copy, yjs.Y.encodeStateAsUpdate(doc));
check('a document made with one reads with the other', copy.getText('t').toString() === 'hi');

// --- pdf.js: the PDF viewer where the browser has none ---

const { log, warn } = console;
const quiet = () => {
	// pdf.js says in Node that it can't draw here and looks for a canvas package; drawing is not what is tested.
	console.log = console.warn = () => {};
};
const loud = () => Object.assign(console, { log, warn });
quiet();
const pdfjs = await import(`${ROOT}/vendor/pdf.js`);
loud();
pdfjs.GlobalWorkerOptions.workerSrc = new URL(`file://${ROOT}/vendor/pdf.worker.js`).href;
const worker = readFileSync(`${ROOT}/vendor/pdf.worker.js`, 'utf8');
check('pdf.js and its worker are the same version', worker.includes(`"${pdfjs.version}"`), pdfjs.version);

// A one-page PDF with a line of text.
const objects = [
	'<< /Type /Catalog /Pages 2 0 R >>',
	'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
	'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
	'<< /Length 43 >>\nstream\nBT /F1 12 Tf 20 50 Td (Hello PeerKit) Tj ET\nendstream',
	'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];
let pdf = '%PDF-1.4\n';
const offsets = objects.map((body, i) => {
	const at = pdf.length;
	pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
	return at;
});
const xref = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(at => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

quiet();
const task = pdfjs.getDocument({ data: new TextEncoder().encode(pdf), isEvalSupported: false, enableXfa: false, verbosity: 0 });
const opened = await task.promise;
const page = await opened.getPage(1);
const text = (await page.getTextContent()).items.map(item => item.str).join('');
loud();
check('pdf.js opens a PDF: its pages, their size and text', opened.numPages === 1 && page.getViewport({ scale: 1 }).width === 200 && text === 'Hello PeerKit', text);
await task.destroy();

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
