# PeerKit

A mobile-first static web app for peer-to-peer tools built on peerjs (WebRTC). Up to 8 devices share a room (QR code, link, 4-word code or recent rooms) and use the tools over it; the room keeps working when anyone leaves. Tools so far: Transfer (text and files), Stream (camera and screen) and Editor (shared documents), and everyone in the room can talk over voice chat. Android Chrome and desktop browsers are the targets. The UI is in English.

`PLAN.md` is the roadmap: vertical slices, each with a checklist the user ticks. When a slice is done, update its **As built** section.

## Restriction

**Do not use git.** No commits, branches, diffs, status or any other git command. The user handles version control.

## Structure

```
index.html              app shell; loads vendor/*.js as globals, then app/main.js
icon.svg                app icon (three linked peers); favicon.ico, apple-touch-icon.png and icon-*.png are rendered from it
manifest.webmanifest    PWA: name, icons, standalone, and the Android share target
sw.js                   service worker: installability, the offline shell (network first), and the share POST
LICENSE                 MIT; vendored libraries keep their own licences (vendor/README.md)
app/main.js             boot: room from the link or storage, views, room bar, invite and leave sheets, Settings navigation
app/room.js             Room: member peer, anchor, links with every member (handshake, ctl + file connections), reconnect
app/rooms.js            room codes, derived IDs and proofs, room links, the open room and recent rooms (localStorage)
app/crypto.js           SHA-256 and HMAC in plain JS (WebCrypto is missing on http://<lan-ip>)
app/protocol.js         PROTOCOL_VERSION, channels, message list
app/version.js          APP_VERSION, shown in Settings → About
app/voice.js            room voice: microphone, one call per pair, mute, who is speaking
app/pwa.js              service worker registration and Chrome's install prompt
app/share.js            reads what sw.js kept from an Android share
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
test/                   Node tests: run.mjs, room-test.mjs, editor-sync-test.mjs, dom/ (jsdom, needs npm install here)
demos/                  the old standalone demos with their own old libraries; don't change them
docs/turn-server.md     coturn setup guide (the user runs the server)
4player-nes/            local reference only, not committed: Kosmi's NES Party (FCEUX wasm build + glue code)
```

## Commands

The app has no build step. There are two package.json files, neither in the repo root: `vendor/editor-src/` builds `vendor/editor.js` once (the result is committed) and `test/` holds jsdom for the DOM tests. Never run npm in the repo root, and delete `vendor/editor-src/node_modules` after a rebuild.

- Serve locally: `python3 -m http.server`, then open `http://localhost:8000`
- Syntax check: `for f in app/*.js app/*/*.js app/*/*/*.js; do node --check "$f"; done`
- Tests: `node test/run.mjs` (one name to run one, `--times 20` to repeat the random anchor handover). See `test/README.md`; the `dom/` tests need `npm install` in `test/`.
- npm here has `min-release-age=21`: pin versions at least 21 days old instead of overriding it.
- Icons after editing `icon.svg` (ImageMagick renders SVG badly, so QuickLook does the rendering; the square copy is for iOS, which masks the corners itself, and the maskable one is the icon at 72 % on a full-bleed background, inside Android's safe circle):
  `sed 's/ rx="14"//' icon.svg > /tmp/icon-square.svg && cp icon.svg /tmp/ && qlmanage -t -s 1024 -o /tmp /tmp/icon.svg /tmp/icon-square.svg`,
  then `magick /tmp/icon-square.svg.png -resize 180x180 -background '#2f6fed' -alpha remove -alpha off -strip apple-touch-icon.png`,
  `magick /tmp/icon.svg.png -resize 192x192 -strip icon-192.png` (also 512),
  `magick /tmp/icon.svg.png -resize 48x48 -strip ico48.png` (also 32 and 16) `&& magick ico16.png ico32.png ico48.png favicon.ico`.
  The maskable one: build `/tmp/icon-maskable.svg` as `<rect width="64" height="64" fill="#2f6fed"/>` plus icon.svg's shapes (without its own rect) inside `<g transform="translate(32,32) scale(0.72) translate(-32,-32)">`, render it the same way, then
  `magick /tmp/icon-maskable.svg.png -resize 512x512 -background '#2f6fed' -alpha remove -alpha off -strip icon-maskable-512.png`
- Phone testing needs HTTPS (the GitHub Pages URL). Camera, sensors, clipboard, Wake Lock and Web Locks don't work on `http://<lan-ip>`.
- Browser testing isn't expected: check logic with the tests in `test/` instead, and add to them when a slice adds behaviour. Stub `window`, `document`, `localStorage`, `navigator`, `location` and a fake `Peer` before importing: `util.js` and the stores touch those globals at import time. `Room` takes an `identity` ({id, name}) so several simulated devices can run in one process.

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
- **Tools:** a tool is `{ id, title, supported(), mount(el, room, ctx) → unmount }`, where `ctx = { room, activate(), notify(), visible(), onShow(fn), onShare(fn), voiceActive(), onVoiceChange(fn) }` and `ctx.room` is the room ID. Tools use `room.members`, `room.member(peerId)`, `room.send(ch, msg, to?)`, `room.sendBinary(to, data)`, `room.call(to, …)` and the events `msg:<ch>` / `binary` / `call` (with the member). Tools mount when the room first opens and stay mounted.
- **Shared editor:**
  - One Y.Doc per room: map `docs`, id → Y.Map `{name, lang, created, text: Y.Text}`, stored in IndexedDB as `peerkit.doc:<room ID>` through y-indexeddb. Leave and forget deletes that database.
  - `vendor/editor.js` loads with `import()` the first time the Editor tab opens, or when the first `doc` message arrives. Messages that arrive earlier are queued with their member.
  - The provider keeps a `LinkState` per member (queue, split parts); it is also the Yjs origin of what arrives on that link. Messages are base64url on ctl, split into `part`s under the 16 KB limit and paced by `room.controlBuffered(peerId)`.
  - Every link up sends sync step 1 and all known awareness states. Updates from a member are forwarded only to members not linked to it. A link down removes the awareness states heard only through it (and their clocks) and resyncs with the others.
  - Line breaks must be `\n` in the Y.Text: CodeMirror counts a line break as one character.
- **Voice:** `app/voice.js` is room-level, not a tool: it is mounted from `main.js`, its controls are a row in the room bar (so mute is one tap from every tab) and its `<audio>` elements sit in a container on `body`, outside the tool panels. One call per pair, not per direction: of two members in voice the one with a microphone dials, the lower peer ID when both have one, and the other answers with its own microphone (`metadata.kind === 'voice'`). A device with no microphone, or one that refused it, joins as a **listener**: always muted, never dials, called by the others. Mute is `track.enabled = false` plus a `voice` message, because peerjs can't renegotiate; joining and leaving voice do re-make the calls. Who is speaking is measured locally with a Web Audio `AnalyserNode` per stream (never sent), and the others always play through `<audio>` elements so the browser's echo cancellation sees them.
- **Media:** a stream goes to one member for now (a picker when there are several). It can be started in an empty room: the capture runs with no viewer (`out.to === null`, the bar says it is waiting) and the first member to arrive gets it, so you can set the screen share up before sending the invite. Calls go through the signaling server (`room.call`). Start, stop and close also go over ctl, because peerjs closes a call only when ICE fails. A dropped link pauses a stream for 30 s and re-calls the same device (by device ID) with the same stream id. Screen audio skips voice processing and is sent as stereo music-bitrate Opus through `sdpTransform`, applied on both the call and the answer.
- **TURN:** a device setting (`peerkit.turn`), not part of a server profile. `IceConfig` owns the `config` object passed to `new Peer()`; peerjs reads it for every new RTCPeerConnection, so credentials are replaced in place. A member with a secret mints 7-day credentials (`forRoom`) for links, `welcome` and a `turn` message on every link up; others adopt credentials only if they expire later, and pass them on. The secret stays on the device.
- **Versions:** `APP_VERSION` in `app/version.js` is `0.<last finished slice>.<fix>` and shows in Settings → About; bump it when a slice is finished, the patch number for work between slices. `VERSION` in `sw.js` names the cache and must be the same string (the pwa test checks it). `PROTOCOL_VERSION` in `app/protocol.js` changes only when messages change incompatibly (5 = rooms with voice; 4 answered every media call as a stream), and members with different numbers refuse to link.
- **PWA and the share target:** `sw.js` is a classic worker (Firefox has no module workers) and serves network first with the cache as fallback, so an update is never held back; its `SHELL` must list every file under `app/` and `vendor/` except `vendor/editor.js`, which is cached when the Editor tab is first opened. An Android share is a POST that a static host can't answer: the worker stores the files and text in the `peerkit-share` cache and redirects to `./?share=1`; `app/share.js` reads that cache once, and only when a room is open, so the share survives the reload that opening a room does. `ctx.onShare(fn)` hands it to the Transfer tool. Cache storage is missing on `http://<lan-ip>`, so every call is guarded.
- **Stored data:** localStorage data is versioned (`peerkit.settings`, `.room`, `.device`, `.turn`, `.editor`, `.voice`); editor documents live in IndexedDB. `peerkit.rooms` / `.recent` from pairing are only checked for a one-time notice. Validate everything read from storage, links or members, because all of it is untrusted.
- **Settings screen:** it is a history entry (`pushState`), so the Android back gesture closes it. Editors are modal `<dialog>`s. A room stays on the server from its link; the active profile is for new rooms and typed codes.
- **Layout:** `.app` is a flex column, not a grid, so hidden bars don't break the layout. Inputs use 16px text so mobile browsers don't zoom on focus.
- **Code style:** tabs, ES modules and the `h()` element builder. Never use `innerHTML` with untrusted text (see `linkify`). Write control characters in regexes as escapes (`\x00`), never raw.
