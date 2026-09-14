# vendor

Third-party code, committed as ready-to-load files so the app itself has no build step.

| File | What | Version | Licence |
|---|---|---|---|
| `peerjs.min.js` | peerjs UMD build, defines `window.Peer` | 1.5.5 | MIT |
| `qrcode.js` | QRCode.js by davidshimjs, defines `window.QRCode` | — | MIT |
| `editor.js` | Shared editor bundle (ES module): CodeMirror 6, Yjs, y-protocols, y-indexeddb, y-codemirror.next, VS Code keymap | pinned in `editor-src/package.json` | MIT; the comment at the top lists every bundled package with its version and licence |

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
