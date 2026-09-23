# vendor

Third-party code, committed as ready-to-load files so the app itself has no build step.

| File | What | Version | Licence |
|---|---|---|---|
| `peerjs.min.js` | peerjs UMD build, defines `window.Peer` | 1.5.5 | MIT |
| `qrcode.js` | QRCode.js by davidshimjs, defines `window.QRCode` | — | MIT |
| `editor.js` | Shared editor bundle (ES module): CodeMirror 6, Yjs, y-protocols, y-indexeddb, y-codemirror.next, VS Code keymap | pinned in `editor-src/package.json` | MIT; the comment at the top lists every bundled package with its version and licence |
| `dockview.js`, `dockview.css` | dockview-core, the desktop layout's panels (ES module; its stylesheet) | 8.2.0 | MIT (`dockview.LICENCE.md`) |
| `words.js` | BIP-39 English word list (2048 words) for room codes, as an ES module | from `@scure/bip39` 2.3.0 | MIT (header in the file) |

## words.js

Generated once from `wordlists/english.js` of `@scure/bip39` 2.3.0 (npm pack, not installed). The list must stay exactly as it is: room codes and the IDs derived from them depend on it, so changing a word breaks existing rooms.

## editor.js

Built once with esbuild from pinned npm versions. `app/tools/editor/editor.js` loads it with `import()` the first time the Editor is needed, so other tools never download it.

- `editor-src/entry.js` lists everything the app uses. To use another CodeMirror extension or language, export it there and rebuild.
- `editor-src/build.mjs` runs esbuild and writes the package list into the banner.
- `editor-src/package.json` pins every direct dependency; `package-lock.json` pins the rest.
- Everything is bundled into one file on purpose: yjs and `@codemirror/state` break if two copies are loaded.

### Rebuild

Needs Node.js 18+ and npm:

```sh
cd vendor/editor-src
npm ci
npm run build      # writes vendor/editor.js
rm -rf node_modules
```

Check that there's only one copy of the shared packages; every line should say `deduped` except the first of each:

```sh
npm ls --all yjs lib0 @codemirror/state @codemirror/view
```

### Upgrading

1. Change the versions in `editor-src/package.json` and run `npm install` to update the lock file.
2. The versions were chosen to be at least 21 days old (the npm setting `min-release-age=21`). Keep that rule for new versions.
3. Rebuild, then check in the app: typing on both devices, remote cursors, undo, search, language highlighting and the dark theme.

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
