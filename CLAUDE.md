# PeerKit

A mobile-first static web app for peer-to-peer tools built on peerjs (WebRTC). Up to 8 devices share a room (QR code, link, 4-word code or recent rooms) and use the tools over it; the room keeps working when anyone leaves. Tools so far: Transfer (text and files), Stream (camera and screen) and Editor (shared documents). Android Chrome and desktop browsers are the targets. The UI is in English.

`PLAN.md` is the roadmap: vertical slices, each with a checklist the user ticks. When a slice is done, update its **As built** section.

## Restriction

**Do not use git.** No commits, branches, diffs, status or any other git command. The user handles version control.

## Structure

```
index.html              app shell; loads vendor/*.js as globals, then app/main.js
app/main.js             boot: room from the link or storage, views, room bar, invite and leave sheets, Settings navigation
app/room.js             Room: member peer, anchor, links with every member (handshake, ctl + file connections), reconnect
app/rooms.js            room codes, derived IDs and proofs, room links, the open room and recent rooms (localStorage)
app/crypto.js           SHA-256 and HMAC in plain JS (WebCrypto is missing on http://<lan-ip>)
app/protocol.js         PROTOCOL_VERSION, channels, message list
app/settings.js         server profiles: validation, link encoding, localStorage store, connection test
app/device.js           per-browser device ID and name
app/turn.js             TURN device setting, credentials (HMAC), IceConfig, relay test, route detection
app/util.js             storage helpers, Web Locks, wake lock, formatting
app/tools/transfer.js   text to everyone, chunked files to each member
app/tools/stream.js     camera / screen over peerjs media calls, to one chosen member
app/tools/editor/       editor.js (shared documents UI, CodeMirror view), provider.js (Yjs sync + awareness with every member)
app/ui/                 dom.js (h() builder, icons, dialogs, toasts), qr.js, start-view.js, settings-view.js, styles.css
vendor/                 peerjs 1.5.5 UMD (window.Peer), qrcode.js, editor.js (CodeMirror 6 + Yjs ES module bundle), words.js (BIP-39 list)
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
- Browser testing isn't expected. To check logic in Node, stub `window`, `document`, `localStorage`, `navigator`, `location` and a fake `Peer` before importing: `util.js` and the stores touch those globals at import time. `Room` takes an `identity` ({id, name}) so several simulated devices can run in one process.

## Things that aren't obvious

- **Room code:** 4 words from the BIP-39 list (about 44 bits), e.g. `amber-otter-quiet-lamp`. The first 4 letters of each word are unique, so `parseRoomCode` accepts prefixes. The code is the only key: anyone who has it joins without approval, and there is no removal (a new room is the way to exclude someone).
- **Derived from the code** (`roomIds`, SHA-256 with a label each): the room ID (storage key for room data), the anchor peer ID `pk-<hash>` (the server never sees the code) and the HMAC key for the handshake.
- **Link format:** `#room=<code>&s=<base64url profile>&r=<TURN credentials>`. `s` is left out for the public server. `r` carries temporary credentials, never the secret. main.js stores the room as current and removes the hash from the address bar. An old `#join=` link shows "Link from an older version".
- **Anchor:** whoever holds the anchor peer ID lets newcomers in over an `entry` connection: handshake, then `welcome` with the member list; the newcomer dials every member. It gives no rights.
  - A known room (made here or opened before) tries to claim the anchor first; `unavailable-id` means someone holds it, so it connects to it instead. An unknown room only looks, and nobody there is `not-found` ("Wait in this room" claims it).
  - When the anchor's link drops or it says `anchor {held:false}`, members check after 0.5 s and claim after a random 0–3 s; the server lets one win.
  - Every 30 s a member not linked to the anchor holder connects to the anchor again, which merges split groups.
  - A holder that drops off the network keeps the ID until the server notices (about 100 s on 0.peerjs.com). A clean close frees it at once.
- **Links:** one per pair of members, each its own `Link` object (connecting → authed → up → closed, used once), so stale callbacks can't touch a newer link.
  - Handshake: `hello` both ways, then `proof`; the proofs are HMACs over role, nonces, both peer IDs and both DTLS fingerprints, so a relay in the middle fails.
  - Two links to one member: the dial from the lower peer ID wins unless the existing link is alive. The same device ID with a new peer ID (a reload) replaces the old link.
  - After a drop the lower peer ID dials again, up to 6 times. `bye` (Leave), `peer-unavailable` and rejections end it.
  - Tool messages that arrive between authed and up are held and delivered after `link-up`.
  - Members send `links` (their direct links) so the editor can forward to members that aren't linked to each other.
- **peerjs quirks:**
  - A peer whose first registration fails is destroyed; one that was registered before is only disconnected (`reconnect()` works on it).
  - `connect()` while disconnected returns `undefined`.
  - `peer-unavailable` arrives only as a peer error, with the ID only in the message text ("Could not connect to peer …"), after the server's expire timeout (about 5 s); the connection is never closed.
  - A device holding the anchor has two Peer objects (member and anchor); both share the `config` object.
  - The log level is global, so always pass `debug: 1`.
- **Room states:** idle → starting → joining → open, or failed. `open` stays while the device is in the room, alone or not; members come and go as `link-up` / `link-down` / `members` events. `signalingLost` doesn't change the state: links keep working.
- **Two DataConnections per link:**
  - `ctl` is JSON with messages under ~16 KB, so long text is split.
  - `file` is raw binary: frames of `[u32 transfer id][bytes]`, with backpressure through `bufferedAmount`.
- **One open room per device:** Web Lock `peerkit:room`. A second tab shows "Open in another tab" and can take over with `steal`.
- **Tools:** a tool is `{ id, title, supported(), mount(el, room, ctx) → unmount }`, where `ctx = { room, activate(), notify(), visible(), onShow(fn) → unsubscribe }` and `ctx.room` is the room ID. Tools use `room.members`, `room.member(peerId)`, `room.send(ch, msg, to?)`, `room.sendBinary(to, data)`, `room.call(to, …)` and the events `msg:<ch>` / `binary` / `call` (with the member). Tools mount when the room first opens and stay mounted.
- **Shared editor:**
  - One Y.Doc per room: map `docs`, id → Y.Map `{name, lang, created, text: Y.Text}`, stored in IndexedDB as `peerkit.doc:<room ID>` through y-indexeddb. Leave and forget deletes that database.
  - `vendor/editor.js` loads with `import()` the first time the Editor tab opens, or when the first `doc` message arrives. Messages that arrive earlier are queued with their member.
  - The provider keeps a `LinkState` per member (queue, split parts); it is also the Yjs origin of what arrives on that link. Messages are base64url on ctl, split into `part`s under the 16 KB limit and paced by `room.controlBuffered(peerId)`.
  - Every link up sends sync step 1 and all known awareness states. Updates from a member are forwarded only to members not linked to it. A link down removes the awareness states heard only through it (and their clocks) and resyncs with the others.
  - Line breaks must be `\n` in the Y.Text: CodeMirror counts a line break as one character.
- **Media:** a stream goes to one member for now (a picker when there are several). Calls go through the signaling server (`room.call`). Start, stop and close also go over ctl, because peerjs closes a call only when ICE fails. A dropped link pauses a stream for 30 s and re-calls the same device (by device ID) with the same stream id. Screen audio skips voice processing and is sent as stereo music-bitrate Opus through `sdpTransform`, applied on both the call and the answer.
- **TURN:** a device setting (`peerkit.turn`), not part of a server profile. `IceConfig` owns the `config` object passed to `new Peer()`; peerjs reads it for every new RTCPeerConnection, so credentials are replaced in place. A member with a secret mints 7-day credentials (`forRoom`) for links, `welcome` and a `turn` message on every link up; others adopt credentials only if they expire later, and pass them on. The secret stays on the device.
- **Protocol changes:** bump `PROTOCOL_VERSION` for incompatible message changes (4 = rooms).
- **Stored data:** localStorage data is versioned (`peerkit.settings`, `.room`, `.device`, `.turn`, `.editor`); editor documents live in IndexedDB. `peerkit.rooms` / `.recent` from pairing are only checked for a one-time notice. Validate everything read from storage, links or members, because all of it is untrusted.
- **Settings screen:** it is a history entry (`pushState`), so the Android back gesture closes it. Editors are modal `<dialog>`s. A room stays on the server from its link; the active profile is for new rooms and typed codes.
- **Layout:** `.app` is a flex column, not a grid, so hidden bars don't break the layout. Inputs use 16px text so mobile browsers don't zoom on focus.
- **Code style:** tabs, ES modules and the `h()` element builder. Never use `innerHTML` with untrusted text (see `linkify`). Write control characters in regexes as escapes (`\x00`), never raw.
