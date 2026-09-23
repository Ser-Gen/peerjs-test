# Tests

Node tests for the app in [`../app`](../app). They run the real files: nothing here re-implements the protocol.

```sh
node test/run.mjs                 # every test
node test/run.mjs room            # one test: room | editor-sync | voice | pwa | app | start | editor
node test/run.mjs room --times 20 # repeat it (the anchor handover uses random delays)
```

| Test | What it covers |
| --- | --- |
| `room-test.mjs` | `app/room.js` with several devices on a fake peerjs network and a virtual clock: joining, the handshake, one link per pair, anchor handover, a silent anchor holder, a wrong code, a relay in the middle, a full room. |
| `editor-sync-test.mjs` | `app/tools/editor/provider.js` with 3–4 members: sync on link up, forwarding to members that are not linked to each other, cursors after a link drops, a 1 MB paste split into messages under the peerjs limit. |
| `voice-test.mjs` | `app/voice.js` with a faked room and the media connections from `dom/fakenet.mjs`: who dials of two members in voice, a device without a microphone joining as a listener, mute both ways, per-member volume, a link that drops and a reload, and calls that belong to another tool. |
| `pwa-test.mjs` | `manifest.webmanifest`, `sw.js` and `app/share.js`: the icons and the share target in the manifest, the shell the worker caches (it fails when a new app file is missing from it), serving files offline, and an Android share from the POST to the files the app reads back. |
| `dom/app-test.mjs room` | `index.html` and `app/main.js` in jsdom with a second, headless member: joining, the room bar, the invite sheet, sending text and a file, a file that arrived from Android's share sheet, joining and leaving voice, the Stream picker, the editor, taking over the anchor, Leave. |
| `dom/app-test.mjs start` | The start screen: a typed code with 4-letter prefixes, an old pairing link, New room, recent rooms, Forget, and the banner about a share that is waiting for a room. |
| `dom/editor-test.mjs` | The Editor tool itself with two members: writing together, the document list, undo per document, deleting, and documents still there after a reload (IndexedDB). |

`dom/fakenet.mjs` is the fake peerjs network shared by the jsdom tests; it is cut from `room-test.mjs`.
`sw-harness.mjs` runs the real `sw.js` in Node: a fake Cache Storage, a `fetch` that reads the repo from disk (and can be
switched off to play offline), and the worker's own events. `app/share.js` reads that same fake cache, so the service
worker and the app are tested against each other rather than against a copy of the format.

## Dependencies

The two `dom/` tests need jsdom and fake-indexeddb:

```sh
cd test && npm install
```

That is the only npm in this repo besides `vendor/editor-src`. Never run npm in the repo root. `test/node_modules` is not committed, and `run.mjs` skips the jsdom tests when it isn't there.

## Writing a test

`util.js` and the stores read `window`, `document`, `localStorage`, `navigator` and `location` when they are imported, so stub those globals (and a fake `Peer`) **before** importing anything from `app/`. `Room` takes an `identity` (`{id, name}`), so several simulated devices can run in one process. Each test prints one `ok` or `FAIL` line per check and exits non-zero when something failed.
