# PeerKit

A mobile-first static web app for peer-to-peer tools built on peerjs (WebRTC). Two devices pair once (QR code, link, room code or recent host) and then use the tools over that session. Tools so far: Transfer (text and files) and Stream (camera and screen). Android Chrome and desktop browsers are the targets. The UI is in English.

`PLAN.md` is the roadmap: vertical slices, each with a checklist the user ticks. When a slice is done, update its **As built** section.

## Restriction

**Do not use git.** No commits, branches, diffs, status or any other git command. The user handles version control.

## Structure

```
index.html              app shell; loads vendor/*.js as globals, then app/main.js
app/main.js             boot: role from the URL hash, views, banners, Settings navigation, approval dialog
app/session.js          Peer lifecycle, pairing, reconnect, the ctl + file connections
app/protocol.js         PROTOCOL_VERSION, channels, message list
app/settings.js         server profiles: validation, link encoding, localStorage store, connection test
app/rooms.js            room codes, trusted guests, recent hosts, link build/parse
app/device.js           per-browser device ID and name
app/turn.js             TURN device setting, credentials (HMAC), IceConfig, relay test, route detection
app/util.js             storage helpers, Web Locks, wake lock, formatting
app/tools/transfer.js   text and chunked file transfer
app/tools/stream.js     camera / screen over peerjs media calls
app/tools/editor/       editor.js (shared documents UI, CodeMirror view), provider.js (Yjs sync + awareness over the session)
app/ui/                 dom.js (h() builder, icons, dialogs, toasts), qr.js, pair-view.js, settings-view.js, styles.css
vendor/                 peerjs 1.5.5 UMD (window.Peer), qrcode.js, editor.js (CodeMirror 6 + Yjs ES module bundle)
vendor/editor-src/      how editor.js is built: entry.js, build.mjs, pinned package.json + lock (recipe in vendor/README.md)
demos/                  the old standalone demos with their own old libraries; don't change them
docs/turn-server.md     coturn setup guide (the user runs the server)
4player-nes/            local reference only, not committed: Kosmi's NES Party (FCEUX wasm build + glue code)
```

## Commands

The app has no build step and no test suite. The only package.json is `vendor/editor-src/`, which builds `vendor/editor.js` once; the result is committed. Never run npm in the repo root, and delete `vendor/editor-src/node_modules` after a rebuild.

- Serve locally: `python3 -m http.server`, then open `http://localhost:8000`
- Syntax check: `for f in app/*.js app/*/*.js app/*/*/*.js; do node --check "$f"; done`
- npm here has `min-release-age=21`: pin versions at least 21 days old instead of overriding it.
- Phone testing needs HTTPS (the GitHub Pages URL). Camera, sensors, clipboard, Wake Lock and Web Locks don't work on `http://<lan-ip>`.
- Browser testing isn't expected. To check logic in Node, stub `window`, `document`, `localStorage`, `navigator`, `location` and a fake `Peer` before importing: `util.js` and the stores touch those globals at import time.

## Things that aren't obvious

- **Link format:** `#join=<code>&t=<token>&s=<base64url profile>`. `s` is left out for the public server, which a guest then uses (not its own active profile). `t` lets the guest in without an approval prompt. `r` carries temporary TURN credentials, never the secret.
- **Host identity:** the host's peer ID is `pk-<room code>`. The code is stored per server (`serverKey` = host:port+path?key). After a reload the server may still hold the ID, so `unavailable-id` is retried quietly.
- **peerjs quirks:**
  - A peer whose first registration fails is destroyed; one that was registered before is only disconnected (`reconnect()` works on it).
  - `connect()` while disconnected returns `undefined`.
  - `peer-unavailable` arrives only as a peer error; the connection is never closed.
  - The log level is global, so always pass `debug: 1`.
- **Session state machine:** idle → starting → waiting (host) | connecting → pending (guest) → connected, then reconnecting (guest) or failed. `_gen` is bumped on every link teardown, and callbacks from old connections compare against it. Don't drop those checks.
- **Two DataConnections per session:**
  - `ctl` is JSON with messages under ~16 KB, so long text is split.
  - `file` is raw binary: frames of `[u32 transfer id][bytes]`, with backpressure through `bufferedAmount`.
- **Who a host lets in:**
  - Straight in: the current guest's device (a reload), a guest with the token, or a remembered device.
  - An approval prompt: anything else, e.g. a typed code from a new device.
  - Refused: automatic reconnects from a device the host disconnected on purpose (`_ended`).
- **One tab per session:** enforced through Web Locks. A second tab can take the session over with `steal`.
- **Tools:** a tool is `{ id, title, supported(), mount(el, session, ctx) → unmount }`, where `ctx = { room, activate(), notify(), visible(), onShow(fn) → unsubscribe }`. `room` is `code@serverKey`, the same string on both devices. Tools mount on the first connection and stay mounted through reconnects.
- **Shared editor:**
  - One Y.Doc per room: map `docs`, id → Y.Map `{name, lang, created, text: Y.Text}`.
  - It is stored in IndexedDB as `peerkit.doc:<room>` through y-indexeddb.
  - `vendor/editor.js` loads with `import()` the first time the Editor tab opens, or when the first `doc` message arrives. Messages that arrive earlier are queued.
  - The provider sends y-protocols messages as base64url on ctl, split into `part`s under the 16 KB limit and paced by `session.controlBuffered`.
  - Every link up sends sync step 1 and bumps the awareness clock; every link down removes the remote awareness state and its clock.
  - Line breaks must be `\n` in the Y.Text: CodeMirror counts a line break as one character.
- **Media:** calls go through the signaling server (`session.call`). Start, stop and close also go over the control channel, because peerjs closes a call only when ICE fails. A dropped link pauses a stream for 30 s and re-calls it with the same id. Screen audio skips voice processing and is sent as stereo music-bitrate Opus through `sdpTransform`, applied on both the call and the answer.
- **TURN:** a device setting (`peerkit.turn`), not part of a server profile. `IceConfig` owns the `config` object passed to `new Peer()`; peerjs reads it for every new RTCPeerConnection, so credentials are replaced in place, never by recreating the Peer. A host sends 7-day credentials in links and `welcome`; the secret stays on the device.
- **Protocol changes:** bump `PROTOCOL_VERSION` for incompatible message changes.
- **Stored data:** localStorage data is versioned (`peerkit.settings`, `.rooms`, `.recent`, `.device`, `.turn`, `.editor`); editor documents live in IndexedDB. Validate everything read from storage, links or the peer, because all of it is untrusted.
- **Settings screen:** it is a history entry (`pushState`), so the Android back gesture closes it. Editors are modal `<dialog>`s.
- **Layout:** `.app` is a flex column, not a grid, so hidden bars don't break the layout. Inputs use 16px text so mobile browsers don't zoom on focus.
- **Code style:** tabs, ES modules and the `h()` element builder. Never use `innerHTML` with untrusted text (see `linkify`).
