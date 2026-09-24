# vendor

Third-party code, committed as ready-to-load files so the app itself has no build step.

| File | What | Version | Licence |
|---|---|---|---|
| `peerjs.min.js` | peerjs UMD build, defines `window.Peer` | 1.5.5 | MIT |
| `qrcode.js` | QRCode.js by davidshimjs, defines `window.QRCode` | — | MIT |
| `yjs.js` | Shared data bundle (ES module): Yjs, y-protocols, y-indexeddb. The chat's room document and the editor use this one copy | pinned in `editor-src/package.json` | MIT; the comment at the top lists every bundled package with its version and licence |
| `editor.js` | Shared editor bundle (ES module): CodeMirror 6, y-codemirror.next, VS Code keymap. It imports Yjs from `yjs.js` | pinned in `editor-src/package.json` | MIT; listed the same way |
| `dockview.js`, `dockview.css` | dockview-core, the desktop layout's panels (ES module; its stylesheet) | 8.2.0 | MIT (`dockview.LICENCE.md`) |
| `pdf.js`, `pdf.worker.js` | pdf.js (`pdfjs-dist`), the chat's PDF viewer where the browser has none (Android Chrome); its legacy build | 6.3.289 | Apache-2.0 (`pdf.LICENSE`) |
| `words.js` | BIP-39 English word list (2048 words) for room codes, as an ES module | from `@scure/bip39` 2.3.0 | MIT (header in the file) |

## words.js

Generated once from `wordlists/english.js` of `@scure/bip39` 2.3.0 (npm pack, not installed). The list must stay exactly as it is: room codes and the IDs derived from them depend on it, so changing a word breaks existing rooms.

## yjs.js and editor.js

Both are built once with esbuild from the pinned npm versions in `editor-src/`.

- `yjs.js` (0.1 MB) is Yjs and its sync, awareness and IndexedDB helpers (`editor-src/yjs-entry.js`). `app/roomdoc.js` loads it as soon as a room opens, for the chat, so the service worker caches it with the app.
- `editor.js` (0.7 MB) is CodeMirror and the Yjs binding for it (`editor-src/entry.js`). `app/tools/editor/editor.js` loads it with `import()` the first time the Editor is needed (the chat's viewer does too, for text files), so other tools never download it.
- Yjs breaks if two copies are loaded, so `editor.js` carries none: `build.mjs` leaves `yjs` and `./yjs.js` as imports of `./yjs.js` next to it, and `editor.js` passes on the `Y`, `syncProtocol`, `awarenessProtocol`, `encoding`, `decoding` and `IndexeddbPersistence` it gets from there. `@codemirror/state` breaks the same way, so all of CodeMirror is in the one file. Its other shared helpers (a few `lib0` modules) are stateless and are in both. `node test/run.mjs vendor` checks that the two files share one Yjs.
- To use another CodeMirror extension or language, export it in `editor-src/entry.js` and rebuild.
- `editor-src/build.mjs` writes into each banner the packages that ended up in that file (from esbuild's list of inputs, with the versions from the lock file).
- `editor-src/package.json` pins every direct dependency; `package-lock.json` pins the rest.

### Rebuild

Needs Node.js 18+ and npm:

```sh
cd vendor/editor-src
npm ci
npm run build      # writes vendor/yjs.js and vendor/editor.js
rm -rf node_modules
```

The build is reproducible: the same lock file gives the same two files byte for byte.

Check that there's only one copy of the shared packages; every line should say `deduped` except the first of each:

```sh
npm ls --all yjs lib0 @codemirror/state @codemirror/view
```

### Upgrading

1. Change the versions in `editor-src/package.json` and run `npm install` to update the lock file.
2. The versions were chosen to be at least 21 days old (the npm setting `min-release-age=21`). Keep that rule for new versions.
3. Rebuild, then check in the app: the chat on two devices, typing on both devices, remote cursors, undo, search, language highlighting and the dark theme. Run `node test/run.mjs vendor editor chat`.

## dockview.js and dockview.css

dockview-core, used by `app/ui/layout.js` for the panels on a wide screen with a mouse. It has no dependencies, so nothing is built: both files come straight out of the npm package (npm pack, not installed). `layout.js` loads them only on a wide screen, so phones never fetch them, and the service worker caches them on first use.

- `dockview.js` is `dist/package/main.esm.min.mjs`, unchanged.
- `dockview.css`: the package ships its stylesheet only inside the UMD build `dist/dockview-core.js`, which injects it into the page when it loads. The ES module build leaves it out, so it is taken out of the UMD build as is, under a short comment saying where it came from.
- `dockview.LICENCE.md` is the package's `LICENCE.md`.
- The app's own look (colours from its variables, the unread dot, the group buttons) is in `app/ui/styles.css` under `.dockview-theme-peerkit`; the vendored stylesheet is never edited.

### Upgrading

Pick a version at least 21 days old (the npm setting `min-release-age=21`), then:

```sh
cd "$(mktemp -d)"
npm pack dockview-core@8.2.0 && tar xzf dockview-core-*.tgz
cp package/dist/package/main.esm.min.mjs <repo>/vendor/dockview.js
cp package/LICENCE.md <repo>/vendor/dockview.LICENCE.md
node -e '
const src = require("fs").readFileSync("package/dist/dockview-core.js", "utf8");
let i = src.indexOf("s.textContent = \"") + 16; const from = i;
for (i++; src[i] !== "\""; i++) if (src[i] === "\\") i++;
process.stdout.write(JSON.parse(src.slice(from, i + 1)));
' > dockview.css   # then put the comment header back on top and copy it to <repo>/vendor/
```

Then check on a laptop: dragging a tab to split, resizing, Float and Maximize, Reset layout, reloading (the layout comes back), narrowing the window to the bottom tabs and back, and the dark theme. Run `node test/run.mjs desktop`.

## pdf.js and pdf.worker.js

pdf.js from `pdfjs-dist`, used by the chat's file viewer (`app/tools/chat/viewer.js`) only where the browser has no PDF viewer of its own (`navigator.pdfViewerEnabled` is false, as on Android Chrome). Desktop browsers show a PDF in their own viewer, so they never download it; the service worker caches it on first use.

- `pdf.js` is `legacy/build/pdf.min.mjs` and `pdf.worker.js` is `legacy/build/pdf.worker.min.mjs`, unchanged. They are renamed to `.js` so every static server sends them as JavaScript (a module must be).
- The **legacy** build, not the modern one: pdf.js 6's modern build calls brand-new JavaScript (`Uint8Array.prototype.toHex`, for one) that only the newest browsers have, and a phone's browser or WebView is often a few versions behind. The legacy build carries what it needs.
- Left out: `cmaps/` (for Chinese, Japanese and Korean text in PDFs whose fonts aren't embedded), `standard_fonts/` and `wasm/` (JPEG 2000 images, colour profiles). Most PDFs embed their fonts; the ones that don't show with a stand-in font, and JPEG 2000 images (some scans) don't show.
- The viewer draws pages onto canvases only, with no text, annotation or form layer, so nothing in a PDF can run.
- `pdf.LICENSE` is the package's `LICENSE` (Apache-2.0).

### Upgrading

Pick a version at least 21 days old (the npm setting `min-release-age=21`), then:

```sh
cd "$(mktemp -d)"
npm pack pdfjs-dist@6.3.289 && tar xzf pdfjs-dist-*.tgz
cp package/legacy/build/pdf.min.mjs <repo>/vendor/pdf.js
cp package/legacy/build/pdf.worker.min.mjs <repo>/vendor/pdf.worker.js
cp package/LICENSE <repo>/vendor/pdf.LICENSE
```

Run `node test/run.mjs vendor` (it opens a PDF with it), then open a PDF from the chat on an Android phone.
