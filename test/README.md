# Tests

Node tests for the app in [`../app`](../app). They run the real files: nothing here re-implements the protocol.

```sh
node test/run.mjs                 # every test
node test/run.mjs room            # one test: room | editor-sync | voice | pwa | vendor | app | start | desktop | editor | chat | whiteboard
node test/run.mjs room --times 20 # repeat it (the anchor handover uses random delays)
```

| Test | What it covers |
| --- | --- |
| `room-test.mjs` | `app/room.js` with several devices on a fake peerjs network and a virtual clock: joining, the handshake, one link per pair, anchor handover, a silent anchor holder, a wrong code, a relay in the middle, a full room, two newcomers at once finding each other through the members' `links`. |
| `editor-sync-test.mjs` | `app/docsync.js` (the editor's documents) with 3–4 members: sync on link up, forwarding to members that are not linked to each other, cursors after a link drops, a 1 MB paste split into messages under the peerjs limit. |
| `voice-test.mjs` | `app/voice.js` with a faked room and the media connections from `dom/fakenet.mjs`: who dials of two members in voice, a device without a microphone joining as a listener, mute both ways, per-member volume, a link that drops and a reload, calls that belong to another tool, the copy of a track the level meter reads (never the stream the `<audio>` element plays), a member marked as one we cannot hear yet (no call, no media through it), and the ways a pair without a call finds its way back. |
| `vendor-test.mjs` | The vendored bundles fit together: `vendor/editor.js` hands out the Yjs of `vendor/yjs.js` and has no copy of its own, and pdf.js (`vendor/pdf.js` with its worker) opens a PDF and reads its text. |
| `pwa-test.mjs` | `manifest.webmanifest`, `sw.js` and `app/share.js`: the icons and the share target in the manifest, the shell the worker caches (it fails when a new app file is missing from it), serving files offline, and an Android share from the POST to the files the app reads back. |
| `dom/app-test.mjs room` | `index.html` and `app/main.js` in jsdom with a second, headless member (its chat is a room document of its own): joining, the room bar, the invite sheet, chat text both ways, a file each way, a file that arrived from Android's share sheet, joining and leaving voice, the Stream picker, the editor, a board on the Whiteboard, taking over the anchor, a camera started in an empty room that the next member receives, a viewer who leaves and comes back after the grace (the Stream tool's own timers run 100× faster here), Leave. |
| `dom/app-test.mjs desktop` | The same app in a wide window with a mouse: the tools as dockview panels in the default layout, maximize and the unread dot, a stream bringing its panel to the front, float, the saved layout, narrowing to bottom tabs with the same tool elements and widening back, Reset layout, a layout saved before the Whiteboard (kept, with the Whiteboard added), and a saved layout for other tools. |
| `dom/app-test.mjs start` | The start screen: a typed code with 4-letter prefixes, an old pairing link, New room, recent rooms, Forget, and the banner about a share that is waiting for a room. |
| `dom/chat-test.mjs` | The Chat with real rooms on the fake network, five devices plus a headless one: the history a newcomer gets, a photo sent once (the viewer, Download, "Not kept" for a newcomer), files kept for the room on every device, a newcomer fetching one after its sender left (checked byte for byte), the viewer for code, HTML (as source, nothing runs) and PDF, a forged copy that fails its hash, a long history and Show earlier, Remove from room on every device, the storage limit dropping the oldest file, and trimming the history. |
| `dom/whiteboard-test.mjs` | The Whiteboard with real rooms on the fake network, three devices plus a headless one: strokes in progress seen by the others, three drawing at once, simplification and pressure, undo of one's own strokes only, the highlighter, colours and sizes, the eraser, a pinch, a palm after a stylus, drawing offline and merging, images pasted with Ctrl+V and the Paste button (a big photo made smaller), a paste into a text field, moving and resizing, a drop, the board list, forged items and awareness, and the PNG sent to the Chat. jsdom has no canvas: a recording 2D context, `createImageBitmap` and `toBlob` stand in, with fake images that carry their size in their first bytes. |
| `dom/editor-test.mjs` | The Editor tool itself with two members: writing together, the document list, undo per document, deleting, and documents still there after a reload (IndexedDB). |

`dom/fakenet.mjs` is the fake peerjs network shared by the jsdom tests; it is cut from `room-test.mjs`. `dom/fakeopfs.mjs` is a small
in-memory origin private file system for the kept files; the chat test gives each device its own storage key, so the devices
in one process keep their files apart.
`sw-harness.mjs` runs the real `sw.js` in Node: a fake Cache Storage, a `fetch` that reads the repo from disk (and can be
switched off to play offline), and the worker's own events. `app/share.js` reads that same fake cache, so the service
worker and the app are tested against each other rather than against a copy of the format.

## Dependencies

The `dom/` tests need jsdom and fake-indexeddb:

```sh
cd test && npm install
```

That is the only npm in this repo besides `vendor/editor-src`. Never run npm in the repo root. `test/node_modules` is not committed, and `run.mjs` skips the jsdom tests when it isn't there.

## Writing a test

`util.js` and the stores read `window`, `document`, `localStorage`, `navigator` and `location` when they are imported, so stub those globals (and a fake `Peer`) **before** importing anything from `app/`. `Room` takes an `identity` (`{id, name}`), so several simulated devices can run in one process. Each test prints one `ok` or `FAIL` line per check and exits non-zero when something failed.
