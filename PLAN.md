# PeerKit — plan for merging the peerjs demos into one tool

A single mobile-first static web app. Two devices pair once (QR, link or short code) and then use every tool over that one session. From Slice 7 a session becomes a **room** of up to about 6 people that keeps working when anyone leaves. These tools grow out of the existing demos: ping, share, screen, webcam, recorder, gyro and gamepad.

## Decisions (from the interview)

| Topic | Decision |
|---|---|
| Stack | Static files with no build step: `index.html` plus native ES modules. Libraries are vendored in `vendor/`. Hosted on GitHub Pages. |
| Session | Pair once, then use all tools. Either side can open any tool. |
| Peers | 1-to-1 until Slice 6. From Slice 7, rooms of several equal members (see **Decisions for rooms**). |
| Server | Public 0.peerjs.com is the default. Users can add named profiles for their own peerjs-server and switch between them. |
| Sharing config | The server profile goes into the link/QR (`#` fragment). The guest uses it right away and gets a one-tap "Save profile" option. |
| Join methods | QR, copy/share link, short room code, list of recent hosts. |
| Reconnect | The host keeps a stable ID, so old QR codes stay valid. Both sides reconnect automatically. |
| Files | Chunked with progress, in memory. Saving straight to disk for unlimited size is postponed (see **Postponed**). |
| Recorder | Postponed (see **Postponed**). |
| Gyro / gamepad | Become the controller input layer for future party games (NES pad, Wii-tennis / Beat Saber style swing). |
| TURN | Your own coturn server with a shared secret (`use-auth-secret`). The secret stays on your own devices; links carry temporary credentials. Server setup: `docs/turn-server.md`. |
| Shared editor | CodeMirror 6 with VS Code keybindings, synced with Yjs over the existing session. Not Monaco (no mobile support, several MB). Not y-webrtc (its own signaling and peer mesh would duplicate pairing, TURN and trust). |
| NES | The FCEUX WebAssembly build from the local `4player-nes` demo. The host runs the emulator; phones are pads or play remotely from the stream; up to 4 players through Four Score. Kosmi's glue code (`nesparty.js`) is only a reference. |
| Browsers | Android Chrome and desktop browsers. iOS Safari is out of scope, but nothing should rule it out. |
| UI | English. The old demos move to `/demos` and stay as reference. |

## Decisions for rooms (interview on 2026-09-16)

These replace the host/guest rows above from Slice 7 on. The reason: saved documents were keyed by the host's room code, so a later guest of the same host saw an earlier guest's text, and two unrelated hosts that drew the same `word-NN` code could share documents.

| Topic | Decision |
|---|---|
| Rooms | Every session is a room of 2 to about 6 members. Pairing two devices is simply a room of 2. The host/guest model, approval prompts, remembered guests and Recent hosts go away; old data is not migrated. |
| Connections | Full mesh: every member connects to every other member. No member is needed for the room to work, including the one who created it. |
| Code | The code is the room's only key: 4 words from a 2048-word list (about 44 bits), e.g. `amber-otter-quiet-lamp`. Anyone who has it (typed, link or QR) joins without approval. |
| Authority | All members are equal. There is no removal: to exclude someone, create a new room and share its code. |
| Room data | Created together with the room and keyed by an ID derived from its code: documents, chat, file list. A newcomer gets the documents and the chat history. |
| Chat | Transfer becomes the room chat: messages and files in one synced timeline. |
| Files | The sender chooses per file: **Keep for the room** (members store it, so newcomers can download it later) or **Send once** (only members online now). Files open in a built-in viewer without saving them to disk first. |
| Video | The sender sends a separate copy to each viewer, so its upload grows with each viewer. Forwarding by viewers stays a later idea; no video server is planned. |
| Streams | Several members can share at once; each stream is its own panel. |
| Desktop layout | dockview-core: tab groups, drag to split, resize, maximize, saved layout. The default is a main area plus the chat at the side. Phones keep the bottom tabs. |
| TURN | Any member with a TURN secret hands out 7-day credentials to the room; members pass the newest ones along. |
| Devices | One open room per device. Another tab shows "Open in another tab", as now. |
| New tools | Pointer and drawing on streams, a shared whiteboard, and remote control of a PeerKit tool (not of the operating system). |

## Target structure

```
index.html              app shell (mobile-first)
app/
  main.js               boot, hash routing, role detection (host / guest)
  settings.js           server profiles: CRUD, localStorage, encode/decode for links
  rooms.js              room codes, trusted guests, recent hosts (Slice 7: 4-word codes, derived IDs, recent rooms)
  room.js               (Slice 7) members, anchor, mesh of links, join check
  device.js             device ID and name
  turn.js               TURN credentials (HMAC-SHA1), relay test, Direct/Relayed detection
  voice.js              (Slice 8) room voice: mic capture, one call per pair, levels
  session.js            Peer lifecycle, stable id, reconnect, connections, event bus
  protocol.js           message envelope {ch, type, slot, ...} + version
  ui/                   qr, toast, sheet/dialog, status bar, styles.css
  tools/                one module per tool, same interface
    chat/               (Slice 9, was transfer.js) the room chat: timeline, kept files, file transfers, the viewer
    stream.js           camera / screen
    editor/             shared editor: tool UI + Yjs provider over the session
    whiteboard/         (Slice 13) boards drawn together: the tool, boards in their own Y.Doc, the canvas, stroke geometry, images
    controller.js       phone-as-gamepad + gyro
    monitor.js          host-side input visualizer
    nes/                NES tool + frame.html that hosts the emulator
  games/                (later) game modules consuming controller input
vendor/peerjs.min.js    peerjs 1.5.5 UMD
vendor/qrcode.js
vendor/yjs.js           Yjs bundle for the room document and the editor, built once from pinned npm versions (recipe in vendor/README.md)
vendor/editor.js        CodeMirror 6 bundle, built the same way; it imports yjs.js
vendor/pdf.js, pdf.worker.js  (Slice 9) pdf.js for the viewer on Android, Apache-2.0
vendor/dockview.js, .css (Slice 10) dockview-core, MIT
vendor/words.js         (Slice 7) the 2048-word list for room codes, with its licence
vendor/fceux/           FCEUX Emscripten build (js + wasm), GPL-2.0, with a source link
docs/turn-server.md     coturn setup guide
demos/                  old demos, untouched, with their original peerjs/qrcode builds
```

**Tool interface:** `{ id, title, supported(), mount(el, session, ctx) → unmount }`, where `ctx = { activate(), notify() }`. Slice 7 replaces `session` with the room (members, send to one or all), and Slice 10 lets a tool open several panels.
- A tool subscribes to its own channel on the session bus.
- `supported()` hides tools the device can't run. For example, screen share is hidden on Android.

**Link format:** `https://<pages>/#join=<room code>&t=<token>&s=<base64url(profile)>&r=<base64url(TURN credentials)>`
- The fragment never reaches the web server.
- `s` is left out for the default profile, which keeps the QR small.
- `t` is the host's secret: a guest that has it connects without an approval prompt. A typed code has no `t`.
- `r` carries temporary TURN credentials from the host (Slice 5), never the TURN secret.

**Room link format (from Slice 7):** `https://<pages>/#room=<code>&s=<base64url(profile)>&r=<base64url(TURN credentials)>`
- The code is the only secret, so `t` goes away. `s` and `r` stay as they are.
- A room lives on one signaling server: the one in its link.

**Profile shape:** `{ name, host, port, path, key, secure, iceServers? }`
- `iceServers` is a raw list for advanced imports. The TURN server is a device setting, not part of a profile (Slice 5).

---

## Slices

Each slice works end to end on an Android phone and a laptop, and leaves the app clearly better than the slice before it. Work through them in order and finish one checklist before starting the next.

> **Testing on a phone:** camera, sensors, clipboard, Wake Lock and `crypto.randomUUID` only work in a secure context (HTTPS). Test phone features on the GitHub Pages URL, not on `http://<lan-ip>`. On the laptop alone, `python3 -m http.server` (localhost) is fine.

### Slice 1 — Pair and send (first useful slice)

**Why:** this replaces 5 separate pages that each show their own QR with one app that already does something useful: moving text and files between a phone and a laptop.

**Build**
- Move the demos to `/demos` together with their old `peerjs.min.js` and `qrcode.js`, so their `../` paths still work. Upgrade peerjs to the latest 1.x and vendor it. Add a mobile-first shell: status bar, main area, bottom tab bar.
- `session.js`:
  - Uses the default server.
  - The page opens as host unless the URL has `#join=`, in which case it opens as guest.
  - Once connected, the host hides the QR and rejects any further guests.
  - Both sides can send.
- Host screen:
  - A large QR code.
  - A Copy link button and a Share button (`navigator.share`).
  - A "Waiting for guest…" state.
- Status bar:
  - A connection dot.
  - Live RTT from the ping demo, sampled every 2 s and shown as `42 ms`.
  - Shows "Disconnected" when the connection is lost.
  - At this stage, a drop only shows a message; reconnect arrives in Slice 3.
- **Transfer tool:**
  - A text box that sends text. Received links can be clicked, and every message has a copy button.
  - A file picker that accepts several files at once.
  - Files go over a separate `raw` DataConnection labelled `file`:
    - Chunks are 64 KB.
    - Backpressure uses `dataChannel.bufferedAmount` and `bufferedAmountLowThreshold`.
    - Control messages (`offer`, `done`, `cancel`) go over the JSON channel.
  - Each file shows a progress bar, speed and a Cancel button. The receiver builds a `Blob` and gets Download and Share buttons.
  - Wake Lock is held while a transfer runs.
- Human-readable errors: map peerjs `error.type` to plain messages, e.g. "Server unreachable" or "Peer not found — the code may be stale".

**Checklist**
- [x] Opening the site root shows the new app; `/demos/ping/` etc. still work.
- [x] Laptop shows QR; scanning it with an Android phone opens the app and both show "Connected".
- [x] Copy link and Share (on phone) work; pasting the link in another browser connects.
- [x] RTT in the status bar updates on both sides.
- [x] Text sent phone → laptop and laptop → phone appears; links are clickable; copy button works.
- [x] Send a photo from phone to laptop; progress shows; the file downloads and opens.
- [x] Send a ~500 MB video laptop → phone; progress is smooth, the page stays responsive, and the phone screen doesn't sleep.
- [x] Cancel mid-transfer on either side stops both sides cleanly.
- [x] A third device opening the same link is refused with a clear message.
- [x] Layout is usable one-handed on the phone in portrait with no horizontal scroll.

### Slice 2 — Server profiles and config handoff

**Why:** the app no longer depends on the public broker. You can run your own peerjs-server, and a guest gets its settings just by scanning.

**Build**
- A Settings screen with a profile list:
  - "Public (default)" is built in and read-only.
  - Add, edit, duplicate and delete named profiles with the fields host, port, path, key and secure.
  - Mark one profile as active.
  - Storage: `localStorage` with a `version` field so the format can be migrated later.
- A "Test connection" button creates a temporary Peer, waits for `open` or `error`, and reports the result and the time it took.
- The host embeds the active profile in the link/QR when it isn't the default. The host screen shows the server name under the QR.
- Guest opening a link that carries `s`:
  - Connects with that profile for this session, whatever its own active profile is.
  - If the profile isn't saved yet (compare by host+port+path+key), shows a banner: "This session uses server *X* — Save profile".
- Import/export all profiles as JSON (copy/paste) so you can back them up or move them to a new device without pairing.

**As built** (`app/settings.js`, `app/ui/settings-view.js`)
- Settings opens from the gear in the top bar. It is a history entry, so the Android back gesture closes it. Editors are modal `<dialog>`s.
- The Host field accepts a pasted URL (`https://peer.example.com:9000/app`) and splits it into host, port, path and secure.
- A profile can't duplicate a saved server (same host+port+path+key). "Duplicate" is for making a variant with another path or key.
- A new profile is made active by default ("Use for new sessions").
- Changing the active server before anyone has connected restarts the host on the new server with a fresh QR. After a connection it applies to the next session.
- Import also accepts a PeerKit link that carries `s=`.
- A warning appears when an insecure (`http`) server would be blocked on the HTTPS page.

**Tricky points**
- Profiles and links can be malformed. Validate them and fall back to a clear error instead of a blank page.
- Keep the link short enough for a readable QR. Leave out fields that match peerjs defaults. If the QR gets dense, switch to error-correction level M.

**Checklist**
- [x] Add a profile for your own peerjs-server; "Test connection" reports success. A wrong port reports a readable failure.
- [x] With that profile active, laptop QR shows the server name; phone (with only the default profile) scans it and connects.
- [x] Phone shows the "Save profile" banner; after saving, it appears in the phone's profile list.
- [x] Re-scanning the same QR no longer shows the banner.
- [x] With the default profile active, the link has no `s=` parameter.
- [x] Export profiles on laptop, import on phone — list matches.
- [x] Editing a garbage link fragment by hand shows an error, not a broken page.
- [x] On the laptop before pairing, switch the active server in Settings: back on the QR screen the server name and QR have changed.
- [x] Android back gesture closes Settings (and an open editor dialog) instead of leaving the app.

### Slice 3 — Stable identity, room codes and reconnect

**Why:** everyday use stops being fragile. A reload, a locked phone or a flaky network no longer means scanning again, and a TV host can be joined by typing a code.

**Build**
- The host gets a persistent room code in the `word-NN` format (e.g. `fox-42`), stored per profile.
  - The peer ID is `pk-<code>`. The prefix namespaces IDs on the shared public server.
  - If the ID is taken (`unavailable-id`), retry (see below). After about 60 s, offer "Generate a new code".
  - A "Regenerate code" action is also available on demand.
- A Join screen with a room-code input that joins using the guest's **active** profile, with the profile name shown next to the input.
- **Recent hosts** list on the guest:
  - Stores code, profile, last seen time and an optional nickname.
  - One tap reconnects; items can be removed.
- Reconnect:
  - Signaling lost (`peer.on('disconnected')`): call `peer.reconnect()` with backoff.
  - Data connection closed: the guest retries `connect` with backoff (1, 2, 4… up to 15 s). The status bar shows "Reconnecting…".
  - `visibilitychange` → visible: check health right away instead of waiting for the next timer.
- The host remembers the last guest, identified by a random per-device guest ID sent in the first `hello` message.
  - A remembered guest is auto-accepted when it reconnects.
  - An unknown device joining by typed code shows an "Allow *device name*?" prompt.
- Detect a second tab using the same stable ID and show "App is open in another tab".

**As built** (`app/rooms.js`, `app/device.js`, `app/ui/pair-view.js`, `app/session.js`)
- The start screen has two tabs, **Show code** (big room code, QR, link) and **Join** (code input, server name, Recent hosts). The app remembers the last tab, so a phone that usually joins opens on Join.
- The code is `word-NN` (about 12 000 per server), stored per server in `peerkit.rooms` with a random link token `t` and up to 5 remembered devices. **New code** replaces all three.
- Who gets in without a prompt: a device with the token (QR, link, Recent hosts), a remembered device, or the device that is already the guest (reload). A typed code from an unknown device opens an "Let … connect?" dialog; Esc or the back gesture means no, and 60 s without an answer refuses. An approved guest receives the token, so it isn't asked again.
- The device ID is now per browser (`peerkit.device`, localStorage) instead of per tab. Settings → **This device** sets the name the other side sees.
- One tab per session through the Web Locks API (not available on `http://<lan-ip>`). The second tab shows "Open in another tab" with **Use this tab**, which moves the session there.
- The server refusing the host's ID is retried every 3 s. After 60 s the screen offers **Use a new code**.
- Reconnect: the guest backs off 1, 2, 4… 15 s for as long as the page is open and shows **Retry now**. Returning to the page or the network coming back triggers a check right away: a ping must be answered within 4 s.
- **Disconnect** (host) and **Leave** (guest) send `bye`, so the other side doesn't wait for a reconnect. The host refuses the disconnected device's automatic reconnects, but "Join again" works.
- The Join field also accepts a pasted PeerKit link, and it refuses the device's own code.
- Fix: a guest opening a link without `s` now uses the public server, not its own active profile.
- Not built: nicknames for recent hosts (the host's device name is shown instead) and a list of remembered devices (New code revokes them all).

**Tricky points**
- After a reload, the broker keeps the old ID reserved for roughly the alive timeout (60 s by default on peerjs-server). Expect `unavailable-id` on a fast reload and retry quietly for a while before showing an error.
- Short codes can be guessed. The approval prompt for unknown guests is the only access control, so keep it on by default for typed-code joins.
- A typed code only works if both devices are on the same server. Say so in the UI.

**Checklist**
- [x] Reload the laptop (host): within ~1 min the phone reconnects by itself without re-scanning.
- [x] Lock the phone for 30 s, unlock: connection comes back and status shows it.
- [x] Turn phone Wi-Fi off/on: "Reconnecting…" then "Connected".
- [x] Yesterday's QR (same laptop, same profile) still connects.
- [x] Type the room code on the phone's Join screen: connects.
- [x] A second, never-seen device joining by code triggers an allow/deny prompt on the host.
- [x] Phone's Recent hosts shows the laptop; one tap reconnects after closing the browser.
- [x] Opening the host in a second tab shows the "open in another tab" message; "Use this tab" moves the session and the first tab says so.
- [x] Regenerate code: old QR stops working, new one works.
- [x] Host "Disconnect": the phone shows "Session ended" and doesn't reconnect by itself; "Join again" connects.
- [x] A mistyped code shows "Host not found"; entering the laptop's own code on the laptop is refused.

### Slice 4 — Live camera and screen

**Why:** brings the webcam and screen demos into the session, and fixes their UX problems: the separate "answer" button hack, sound muted with no way back, fixed 600×400 size.

**Build**
- **Stream tool**, with two sources: Camera and Screen. Screen is only offered where `getDisplayMedia` exists (desktop).
- Either side starts a stream with `peer.call(remoteId, stream)`, and the other side answers with no stream. Metadata `{kind:'camera'|'screen'}` goes with the call.
- Camera options: front/back switch using `sender.replaceTrack` (no new call), a mic on/off toggle, and a resolution preset (480p/720p/1080p).
- Receiver:
  - Video fills the available area and autoplays muted, with a clear "Tap for sound" overlay.
  - Buttons for fullscreen and picture-in-picture.
  - A "stream ended" state when the stream stops.
- The sender sees a small self-preview (muted, mirrored for the front camera), plus Stop and "You are sharing your screen" indicators.
- Stream and file transfer run at the same time without breaking each other.

**As built** (`app/tools/stream.js`)
- A **Stream** tab next to Transfer. Each side can share one stream and view one, so both directions can run at once.
- `start` / `stop` / `close` go over the control channel, because peerjs only closes a media call once ICE fails, which is slow. The media call carries `{id, kind}`, and the receiver answers without a stream.
- The receiver switches to the Stream tab when a stream starts. The Transfer tab gets a dot for messages that arrive while it is hidden. Tools receive `ctx = {activate, notify}` in `mount`.
- The receiver's buttons over the video: Mute, Picture-in-picture, Full screen and Close. Close asks the sender to stop. Full screen on a phone locks to landscape for landscape video.
- The sender's bar: Switch camera (only with 2+ cameras; flips facing mode on phones, cycles devices on desktop), Mic, Resolution (`applyConstraints`, or a new track if that fails) and Stop. Resolution, mic and facing are remembered.
- If the link drops, the capture keeps running for 30 s and is sent again on reconnect with the same id, so a screen share needs no new picker. After a reload or a longer drop, a "Resume" strip restarts it with one tap.
- Receiving works on `http://<lan-ip>` too; sharing needs HTTPS. The camera falls back to video only when the mic is missing or blocked.
- Screen audio is captured without echo cancellation, noise suppression or auto gain, marked as music, and sent as stereo Opus at 256 kbit/s (`sdpTransform` on both call and answer). The camera mic keeps voice processing.
- Videos are absolutely positioned inside the stage, so a video's natural size never pushes it under the bars.

**Checklist**
- [x] Phone → laptop: back camera appears on laptop; switch to front camera without the stream restarting.
- [x] Laptop receives muted; "Tap for sound" enables audio.
- [x] Laptop → phone: screen share shows on phone, fullscreen works in landscape.
- [x] "Screen" source is not offered on the phone.
- [x] Stop on the sender makes the receiver show "Stream ended"; starting again works without reload.
- [x] Send a file while a camera stream is running — both work.
- [x] Reload during a stream: session reconnects (Slice 3) and the stream can be restarted with one tap.
- [x] Turn phone Wi-Fi off/on for a few seconds while sharing its camera: the video comes back by itself.
- [x] Both directions at once: phone camera on the laptop and laptop screen on the phone.
- [x] "Close" on the receiver stops the sender's camera (the camera light goes off).
- [ ] The whole video fits between the top bar and the bottom bars, in portrait and landscape, with and without a self-preview.
- [ ] Share the screen with system/tab audio playing music: the sound on the other device is clear, stereo, and doesn't pump or cut out.

### Slice 5 — TURN server

**Why:** pairing works on mobile data, hotel or office Wi-Fi and behind strict NATs, instead of only when the network happens to allow a direct route.

**Build**
- Server side is done by hand, following `docs/turn-server.md` (coturn with `use-auth-secret`).
- Profile gets an optional `turn` block: host, TLS port (default 5349) and secret. The app builds `iceServers` from it: `stun:host:3478`, `turn:host:3478?transport=udp`, `turn:host:3478?transport=tcp` and `turns:host:<tls port>?transport=tcp`.
  - For providers without a shared secret, a "username + password" mode puts static credentials in the profile (and in links, with a warning).
- `app/turn.js`, credentials in the TURN REST format: `username = "<unix expiry>:pk"`, `credential = base64(HMAC-SHA1(secret, username))` through WebCrypto.
  - The owner device mints 24 h credentials when it creates the Peer and replaces them before expiry. peerjs reads `peer.options.config` for every new RTCPeerConnection, so updating `iceServers` in place covers reconnects and media calls without recreating the Peer.
  - WebCrypto needs a secure context: on `http://<lan-ip>` the host can't mint; Settings says so.
- Links: `s` carries `turn: {host, tlsPort, username, credential}` valid for 7 days, never the secret.
  - `welcome` adds fresh 7-day credentials; the guest stores them in its recent-host entry and uses them for reconnects and later joins. The field is optional, so no protocol bump.
  - A guest with expired credentials can still connect through the host's relay in most networks.
- Settings:
  - A "TURN server (optional)" group in the profile editor: Host, Secret (hidden, with Show), TLS port.
  - **Test TURN**: an RTCPeerConnection with `iceTransportPolicy: 'relay'` gathers candidates for up to 8 s and reports "Relay over UDP / TCP / TLS" or the error (`icecandidateerror` codes, e.g. 401 wrong secret, 701 unreachable).
  - **Relay only (for testing)**: a device setting, never in links; forces `iceTransportPolicy: 'relay'`.
  - Export/import of the server list includes the secret, and the export dialog says so.
- Status bar: after connecting, `getStats()` on the ctl connection finds the selected candidate pair and shows **Direct** or **Relayed** next to the round-trip time.
- The "Direct connection failed" and "Connection timed out" errors suggest adding a TURN server when the profile has none.

**As built** (`app/turn.js`, the TURN section of `app/ui/settings-view.js`)
- The TURN server is a **device setting** (`peerkit.turn`), not part of a server profile. It works with the built-in public signaling server too, and for this device as host or guest. Fields: host, port (3478, UDP and TCP), TLS port (5349, empty turns TLS off), and a shared secret or a username and password.
- `IceConfig` owns the RTCConfiguration object given to `new Peer()`. peerjs keeps that object and reads it for every new RTCPeerConnection, so new credentials are written into it in place. Without TURN it holds peerjs's own defaults (or the profile's `iceServers`).
- Credentials: HMAC-SHA1 through WebCrypto (checked against `openssl`). Own ones last 24 h and are renewed after 12 h; guest ones last 7 days and are renewed daily, which changes the link and QR. Renewal is checked on wake-up and hourly. A username and password are used as they are, in links too.
- Links: `&r=` holds `{h, p?, t?, u, c}`. Damaged or expired credentials are ignored and the link still works. `welcome` carries `turn`; the guest adopts it and keeps it in its recent-host entry, so Recent hosts and typed codes reuse it. A guest's own TURN server wins over the host's.
- Settings → **TURN server**:
  - Add / Edit; a pasted `turn:` or `turns:` URL fills host and port.
  - Test: one relay-only RTCPeerConnection per transport, reporting which of UDP, TCP and TLS work, or a 401 / unreachable error.
  - Remove, and **Relay only (for testing)**, which does nothing without TURN credentials.
  - Export and Import include the TURN block; the export warns that it contains the secret.
- Status bar: a **Direct** / **Relayed** chip from `getStats()` on the control connection, checked on pairing and every 10 s; hidden on screens narrower than 352 px.
- A guest that fails with "Direct connection failed" or "Connection timed out" and has no TURN credentials gets a hint and a "TURN settings" button.

**Checklist**
- [x] `docs/turn-server.md` followed: Trickle ICE shows a `relay` candidate for `turn:` and for `turns:`.
- [x] Settings → Test TURN reports a relay with the right secret and a clear error with a wrong one.
- [x] Relay only on the laptop: pairing with the phone works; the status shows Relayed; Transfer and Stream work over it.
- [x] Phone on mobile data, laptop on home Wi-Fi, Relay only off: pairing works.
- [x] Decoding `r` from a pairing link shows temporary credentials and no secret.
- [x] A guest paired more than 24 h ago reconnects from Recent hosts.
- [x] Profiles without TURN behave exactly as before.

### Slice 6 — Shared editor

**Why:** both devices edit the same text live: notes, a shopping list, a config file or a code snippet, without copy-paste ping-pong through Transfer.

**Build**
- Libraries, vendored as one pre-built ES module `vendor/editor.js` (built once with esbuild from pinned npm versions; the recipe goes in `vendor/README.md`, and the app itself still has no build step):
  - `yjs` (CRDT), `y-protocols` (sync + awareness), `y-indexeddb`;
  - CodeMirror 6 (`codemirror`, a few `@codemirror/lang-*`), `y-codemirror.next` (shared cursors, collaborative undo);
  - `@replit/codemirror-vscode-keymap` for VS Code / Monaco shortcuts.
  - Loaded with `import()` the first time the Editor tab opens.
- Yjs provider over the session (`app/tools/editor/provider.js`), channel `doc`:
  - y-protocols sync step 1 / step 2 / update, plus awareness (cursor, selection, device name, colour).
  - Updates are binary; they go base64 on ctl and are split under the 16 KB message limit.
  - On every (re)connect both sides send step 1, so only missing changes cross, and offline edits merge.
  - `PROTOCOL_VERSION` → 3, so a stale tab gets "update the page" instead of a silently unsynced editor.
- Storage: the Y.Doc is kept in IndexedDB per room (`code@serverKey`), so a reload or a later session shows the same documents.
- Documents: a list per room (name, language), with New, Rename, Delete, Open local file, Download, Share and Copy all.
- Editor: plain text, Markdown, JavaScript/TypeScript, JSON, HTML, CSS and Python modes; line wrap and font size toggles; search.
- The other device's cursor and selection show in its colour with its name.
- Mobile: a small toolbar above the keyboard (Undo, Redo, Tab, Outdent, Search). The layout already resizes for the keyboard (`interactive-widget=resizes-content`).
- The Editor tab gets the `notify` dot when the other device edits while the tab is hidden.

**As built** (`app/tools/editor/`, `vendor/editor.js`, `vendor/editor-src/`)
- `vendor/editor.js` is one esbuild bundle: 746 KB, 261 KB gzipped. The comment at its top lists all 34 bundled packages with versions and licences (all MIT). The versions are pinned at least 21 days old; the rebuild recipe is in `vendor/README.md`.
- The bundle loads the first time the Editor tab opens, or when the first `doc` message arrives, so edits from others are kept even if the tab was never opened.
- The Editor bar:
  - the **Documents** button opens a list with Open file and New document;
  - chips show who has this document open;
  - **Search** and the **⋯ options** sheet: name, language, text size, wrap, Copy all, Download, Share and Delete.
- The editor:
  - VS Code keys, line numbers, folding, bracket matching, multiple cursors and rectangular selection.
  - Undo and Redo per document only undo your own edits.
  - The search panel sits at the top, away from the phone keyboard.
  - Plain text and Markdown turn on autocorrect and spellcheck; code modes turn them off.
- Other people's cursors and selections show in their colour, with the name always visible (not only on hover).
- Phones: while editing, a toolbar above the keyboard (Undo, Redo, Outdent, Indent, Search, Done) replaces the tab bar.
- Open file: text files up to 5 MB; a NUL byte means "not a text file". CRLF becomes LF, and the language comes from the extension.
- Stored per device (`peerkit.editor`): text size, wrap, and the last open document per room.
- IndexedDB is probed with a small database first. Where it is blocked, documents last only while the page is open, and the empty state says so.
- Sync: y-protocols messages as base64url on ctl, split into 12 000-character parts and paced at 256 KB buffered. A 1 MB paste is 121 messages.
- If no member answers the first sync within 5 s, the empty state shows anyway.
- Since Slice 7, documents are keyed by the room ID and sync with every member (see Slice 7).

**Checklist**
- [ ] Typing on the laptop appears on the phone as you type; both cursors are visible with device names.
- [ ] Both devices type in the same line at once: no lost characters, and both end with the same text.
- [ ] Phone in airplane mode, edit on both, reconnect: the edits merge on both.
- [ ] Reload either device: the documents are still there and in sync.
- [ ] Laptop shortcuts: Ctrl/Cmd+D, Alt+↑/↓, Ctrl/Cmd+/, Ctrl/Cmd+F, multiple cursors.
- [ ] Android Chrome with Gboard: autocorrect, swipe typing and selection handles work; the toolbar stays above the keyboard.
- [ ] Paste 1 MB of text: it syncs without freezing the session or breaking Transfer.
- [ ] Open a local `.md` file, edit it together, download it.

### Slice 7 — Rooms: several people, no host

**Why:** up to about 6 people share one room, and it keeps working when anyone leaves. This also fixes the document leak: room data belongs to a room, not to a host's code.

**Spike first** (a throwaway page; write the results into this section before the build)
- Anchor handover on the public server and on your own peerjs-server: how soon a peer ID is free again after its holder closes the tab, reloads or loses the network. Expected: at once on a clean close, and up to the server's alive timeout (60 s by default) after a network loss.
- Two Peer objects in one tab (member peer and anchor peer) on Android Chrome: both stay registered, and the phone copes with 5 links of ctl + file connections.
- Two members claim the anchor at the same moment: exactly one gets it, and the other sees `unavailable-id`.

**Build**
- Room identity (`app/rooms.js`, rewritten):
  - **New room** draws a 4-word code from a 2048-word list with `crypto.getRandomValues`. The list is vendored with its licence. Its words differ in their first 4 letters, so the Join field can autocomplete.
  - Derived from the code with SHA-256, each with its own label:
    - the **room ID**, the storage key for all room data;
    - the **anchor peer ID** `pk-<hash>`, so the signaling server never sees the code;
    - the **room key** for the join check.
  - The device keeps its current room (code, server profile, TURN credentials) and a short list of recent rooms. Opening another room leaves the current one.
  - **Leave and forget** deletes the room's documents, chat and kept files from this device.
- Members and connections (`app/room.js`, replacing the host/guest parts of `session.js`):
  - Each device has a **member peer** with a random ID per room.
  - The **anchor** is the member that holds the anchor peer ID. It lets newcomers in and gives them the member list; the newcomer then connects to every member. Being the anchor gives no extra rights.
  - The first member to arrive claims the anchor. When the anchor leaves, the others try to claim it after a random delay of 0–3 s, and the server lets only one succeed. Existing links stay up meanwhile.
  - Every member checks in with the anchor every 30 s and after a reconnect, so two groups that formed during a network split merge again.
  - Each pair of members gets ctl + file connections as today, and the per-link logic (hello, ping, the `_gen` guard, reconnect backoff) runs per link. The member with the lower peer ID dials, so a pair never opens two links.
  - Join check: `hello` carries an HMAC with the room key over both peer IDs and a random challenge, and both sides verify it. Knowing only the anchor peer ID (as the signaling server does) is not enough to join or to pose as a member.
  - A members strip shows each member's device name, a colour from its device ID, online or offline, and Direct or Relayed.
  - If two members can't connect directly, a member linked to both forwards their ctl traffic (documents, chat). Streams and files are not forwarded; the UI says "Not connected to *name*".
- TURN: any member with a TURN secret sends fresh 7-day credentials in `welcome` and every 24 h. Members keep the newest and pass them on to newcomers.
- Tools in this slice:
  - **Transfer**: text and files go to everyone online, with progress per member.
  - **Editor**: one provider per link, documents keyed by the room ID. Each device sends its own awareness state on every link, and cursors use the member colour.
  - **Stream**: to one chosen member for now, until Slice 11.
- Start screen: **New room**, **Join** (a code or a pasted link) and recent rooms. The room screen shows the code, QR, Copy link and Share.
- `PROTOCOL_VERSION` → 4. Old Recent hosts, room codes and editor documents are no longer read, and a one-time notice says rooms replaced pairing.

**Tricky points**
- In a room of 6, each device has 5 links. Pings, route checks and reconnect timers run per link, so keep them cheap on phones.
- An anchor that loses its network doesn't close its socket, so handover can take up to the server's alive timeout. Newcomers see "Looking for the room…" meanwhile; members aren't affected.
- A room whose members are all offline still exists on their devices. Whoever opens it first becomes the anchor, and the rest merge as they arrive.
- The code is a secret shown in the QR, the link and on screen. Anyone who ever had it can come back: that's the cost of having no removal, and **New room** is the way out.

**Spike results** (2026-09-16, public 0.peerjs.com, its signaling protocol spoken from Node)

| Case | Result |
|---|---|
| Claim a free peer ID | registered in about 0.4 s |
| Claim an ID that is held | refused at once (`ID-TAKEN`) |
| The holder closes cleanly | free again after about 0.35 s |
| 5 claims at the same moment | exactly one wins |
| The holder goes silent (no close, no heartbeat) | released after about 100 s |

Two Peer objects in one tab on Android Chrome can only be checked in the browser (see the checklist).

**As built** (`app/room.js`, `app/rooms.js`, `app/crypto.js`, `app/ui/start-view.js`, `app/main.js`)
- **Start screen**: New room, Join (a 4-word code or a pasted room link) and Recent rooms, which lists who was there and has a Forget button.
  - A typed code accepts the first 4 letters of each word, in any case.
  - A one-time note says that earlier pairings and their documents are not carried over.
  - An old `#join=` link shows "Link from an older version".
- **Room screen**:
  - A members bar: "You" plus a coloured chip per member, whose tooltip shows round-trip time and Direct/Relayed, and **Invite**.
  - The top bar shows "N in the room" or "Only you". With exactly one other member it also shows round-trip time and Direct/Relayed, as before.
  - **Invite** is a sheet with the code, QR, link, Copy link, Copy code and Share. It opens by itself for a new room.
  - **Leave** offers Leave (the room stays in Recent rooms) or Leave and forget (also deletes the room's documents from this device).
- The code is the room: its ID, the anchor peer ID and the handshake key are derived from it with SHA-256. SHA-256 and HMAC are plain JS in `app/crypto.js`, because WebCrypto is missing on `http://<lan-ip>`.
- A room link is `#room=<code>&s=…&r=…`. Opening it makes that room current and cleans the address bar; a reload reopens the current room.
- The member peer ID (`pk-m-…`) is random per page load. A reload rejoins as the same device, recognised by its device ID, and replaces the old link on the other members.
- **Finding the room**:
  - A room made or opened here before (known) tries to take the anchor first. If someone holds it, it connects to them. Either way that takes under a second.
  - An unknown room only looks. With nobody there it shows "Nobody is in this room", with **Wait in this room**.
  - While there is no answer (a silent anchor, or a strict network), the joining screen keeps retrying and explains why after 2 attempts.
- **Anchor handover**: when the holder's link drops or it says so, members check after 0.5 s and claim after a random 0–3 s. Every 30 s a member not linked to the holder connects to the anchor again, which also merges split groups.
- **Links**:
  - The handshake is an HMAC over role, nonces, both peer IDs and both DTLS fingerprints, so a wrong code or a relay in the middle is refused ("Could not join").
  - Of two links to the same member, the dial from the lower peer ID wins unless the existing link is alive.
  - After a drop the lower peer ID dials again, up to 6 times. Leave sends `bye`, which removes the member at once.
- Up to 8 devices; the ninth gets "Room is full".
- **TURN**: any member with a secret sends 7-day credentials in `welcome` and on every link up. Others take credentials only if they expire later and pass them on; the room entry stores the newest.
- **Tools**:
  - **Transfer**: text goes to everyone and shows the sender's name. A file goes to each member over its own link, with one card and a line per member. Join and leave show in the feed.
  - **Stream**: goes to one member, picked from a list when there are several. It pauses and resumes with that device, also after it reloads. Since 2026-09-23 it can also start in an empty room and waits there for the first arrival, and a viewer who is gone for more than 30 s no longer stops it: it waits for the next arrival (0.8.3).
  - **Editor**: one provider for all links. Updates and cursors from a member are forwarded to members not linked to it, going by the `links` each member announces. A link going down resyncs with the others.
- `PROTOCOL_VERSION` 4. One open room per device (Web Lock `peerkit:room`). Settings says a room stays on its link's server; the selected server is for new rooms and typed codes.
- Differences from the plan:
  - The limit is 8 devices, not about 6.
  - Transfer text and files reach only directly linked members; forwarding covers documents and cursors, and the synced chat comes in Slice 9.
  - The Direct/Relayed route per member is in the chip tooltip.
- Checked in Node, not in a browser. Since 2026-09-23 these tests live in `test/` and run with `node test/run.mjs` (229 checks in all):
  - `room-test.mjs`: a room simulation on a fake peerjs network with a virtual clock (30 checks, 20 runs in a row).
  - `dom/app-test.mjs`: the whole app in jsdom with a second, headless member (52 checks in a room, 14 on the start screen, 24 in the desktop layout).
  - `editor-sync-test.mjs`: the editor provider with 3–4 members, including forwarding (14 checks).
  - `dom/editor-test.mjs`: the editor UI with two members (26 checks).

**Checklist**
- [ ] The laptop creates a room; the phone joins by QR and a third device by typing the 4-word code: all three see each other in the members strip.
- [ ] Text from any member appears on all the others; a file reaches everyone, with progress per member.
- [ ] Three devices edit one document together, with three coloured cursors.
- [ ] The creator closes its tab: the other two keep chatting and editing, and a fourth device can still join.
- [ ] The anchor loses Wi-Fi: members keep working, and a newcomer gets in within about a minute.
- [ ] One device opens the room alone and edits, then the others arrive: the edits merge.
- [ ] A device that was in room A joins room B: it sees none of A's documents, and B's members never get them.
- [ ] A wrong code shows "Nobody is in this room" with **Wait in this room**.
- [ ] Opening the app in a second tab shows "Open in another tab"; **Use this tab** moves the room there.
- [ ] Android Chrome as the anchor (it holds two peers): other devices still join, and the phone keeps working with 3+ members.
- [ ] Everything from the Slice 6 checklist, now with 3 devices where it applies.
- [ ] Leave and forget: the room is gone from the list, and its documents are gone after a reload.

### Slice 8 — Voice chat in the room

**Why:** you can show a screen to the room but not talk over it. The only voice today rides along with a camera stream and reaches one person. Talking is what makes the rest worth using: writing a document together stops needing a written commentary next to it.

**Decisions (interview on 2026-09-23)**
- The controls live in the room bar, above the tools, so mute is one tap away whichever tab is open. No Voice tab.
- An open mic with a mute button, the way a call normally works. Push-to-talk stays in the backlog.

**Build**
- **Room bar** (`app/main.js`, `app/ui/styles.css`):
  - Not in voice: **Join voice** with the count of who is already talking.
  - In voice: **Mute** / **Unmute**, "3 in voice", **Leave voice**, and a chevron that opens the voice sheet.
  - The member chips carry the state: a ring in the member's colour while that member speaks, a crossed-out mic when muted, nothing when the member is not in voice.
  - Voice sheet: volume per member (a slider and a local mute, so one loud laptop can be turned down here), and the microphone to use when the device has several.
- **`app/voice.js`**, a room-level module mounted from `main.js` beside the tools, not a tool: it has to keep running whichever tool tab is in front.
  - **Join** (on the tap, which is also the gesture that lets audio play): `getUserMedia({ audio: { echoCancellation, noiseSuppression, autoGainControl } })`, then `voice {on: true}` to the room and a call to every member already in voice.
  - **One call per pair, not per direction**: the lower peer ID dials (the rule the links already use) with metadata `{kind: 'voice'}`, and the other side answers with its own microphone, so one connection carries both voices. A member who is not in voice answers with no stream and only listens.
  - peerjs cannot renegotiate a call, so joining and leaving voice close and re-make the calls with the members it concerns. Mute does not: it is `track.enabled = false` plus `voice {muted}`, which everyone shows on the chip.
  - Remote audio plays in one `<audio autoplay>` per member, in a container outside the tool panels so switching tabs never stops it; per-member volume is that element's `volume`. A rejected `play()` shows the same **Tap for sound** button the Stream tool uses.
  - Speech keeps the WebRTC Opus defaults (mono, about 32 kbit/s, silence dropped) — the opposite of the `musicSdp` used for screen audio.
  - A dropped link pauses that member's audio and calls the same device again (by device ID: its peer ID changes after a reload) when the link is back, with the Stream tool's 30 s grace.
  - A wake lock while in voice, released on leave.
  - **Who is speaking**: a Web Audio `AnalyserNode` per stream, local and remote, sampled about 10 times a second, with a threshold and a short hold so the ring doesn't flicker. It stays on the device; nothing about levels is sent.
- **Protocol** (`app/protocol.js`): a new channel `voice`.
  - `voice {on, muted}` — the sender's state, sent on every link up and whenever it changes.
  - `PROTOCOL_VERSION` → **5**. A version-4 device answers any incoming call as a stream, so it would put a voice call on the video stage; members with different numbers already refuse to link, which is exactly what should happen here.
- **Stream tool** (`app/tools/stream.js`): `onCall` ignores calls whose metadata kind is not `camera` or `screen` (today it answers every call). While voice is on, a camera's microphone track is muted and the bar says the voice goes through the room, so nobody is heard twice.

**Tricky points**
- **Echo**: the only cancellation is the browser's, and it cancels what the page plays through media elements — so remote audio has to go through `<audio>` elements, not the Web Audio output. Analysers tap the same stream in parallel.
- **8 members**: 7 uplinks at about 32 kbit/s is nothing for the network, but 7 encoders and 7 decoders warm a phone up. Watch the battery with 4+ devices.
- **Android Chrome with the screen off**: WebRTC audio keeps flowing while timers are throttled, so nothing that keeps the call alive may depend on a timer.
- **Bluetooth headsets** appear as a new input device in the middle of a call: switching means a new `getUserMedia` and a `replaceTrack` on every call.
- **The fake network has no media**: `test/dom/fakenet.mjs` stubs `call()` with an object that does nothing. It needs a fake MediaConnection (a call raises `call` on the target, `answer()` wires both ways) and a fake MediaStream with tracks before any of this can be checked in Node.

**Tests to add**
- `test/voice-test.mjs` on the fake network: who dials, a listener answering without a stream, join / leave / mute reaching everyone, the re-call after a link drop and after a reload, and a stream call and a voice call not being taken for each other.
- The jsdom app test: Join voice shows the mute button and marks the chips, Leave voice closes the calls.

**As built** (2026-09-23, app 0.8.0, `PROTOCOL_VERSION` 5)
- `app/voice.js` is mounted from `main.js` beside the tools, and its `<audio>` elements live in a container on `body`, so nothing stops when the tab changes. The controls are a row in the room bar: **Join voice**, then **Mute** / **Unmute**, the count, **Leave voice** and a chevron for the sheet (volume per member, a local mute, and the microphone when the device has several).
- One call per pair, with metadata `{kind: 'voice'}`: the member with a microphone dials, the lower peer ID when both have one, and the other answers with its own microphone.
- **Not in the plan: a listener.** A device with no microphone, or one where the prompt was refused, still joins — it hears the room, shows as muted to everyone, never dials, and gets a **Use microphone** button to take part after all. So the state message is `{on, muted, mic}`, and the room works on `http://<lan-ip>`, where there is no microphone at all.
- Mute is `track.enabled = false` plus a message; joining and leaving re-make the calls, because peerjs cannot renegotiate.
- Who is speaking comes from a Web Audio `AnalyserNode` per stream and stays on the device. The others' levels are read from a **copy** of the track (see 0.8.2 below). Without Web Audio everything works except the marks. The chips show a ring while someone speaks and a crossed-out microphone when they are muted.
- A link that drops closes that call and forgets the member; when the link is back (a reload brings a new peer ID) the calls are made again by themselves. A call that falls over on its own is retried up to 5 times, a second apart.
- The Stream tool now ignores media calls whose kind is not `camera` or `screen`, and mutes a camera's own microphone while voice is on, so nobody is heard twice.
- Tests: `test/voice-test.mjs` (43 checks after 0.8.2) on a faked room with the media connections from `dom/fakenet.mjs`, which gained a real `call()`, `FakeMediaConnection` and `FakeMediaStream`; the jsdom app test gained 11 checks for the bar, the chips and the call to a member in voice.
- Checked in Node, not in a browser: the checklist below is still to do.

**Checklist**
- [ ] Three devices join voice: everyone hears everyone, and the chips show who is speaking.
- [ ] Mute on the phone: the others see the mark and hear nothing; unmute needs no new permission prompt.
- [ ] A fourth device joins the room while the others talk, taps Join voice and is in the conversation within a couple of seconds.
- [ ] One device leaves voice but stays in the room: the others keep talking, and it still uses the chat and the editor.
- [ ] A laptop on its speakers, without headphones: nobody hears an echo of themselves.
- [ ] The phone shares its camera while in voice: its voice is heard once, not twice.
- [ ] The phone's screen goes off for a minute during a call: the conversation continues.
- [ ] Wi-Fi drops on one device for 10 s: its audio comes back by itself, without a tap.
- [ ] A member behind TURN (relayed) is in voice: audio works both ways.
- [ ] Voice while someone shares a 1080p screen: the voice stays intelligible.
- [ ] Leave the room during a call: the browser's microphone indicator goes out.

### Slice 9 — Room chat, files and viewer

**Why:** the room keeps a shared history. People who join later see what was said and can get what was kept, and files open right in the browser.

**Build**
- Transfer becomes **Chat**: a timeline in a room Y.Doc (`peerkit.room:<room ID>` in IndexedDB), synced like the editor.
  - A message is `{id, from, name, time, text}` or a file entry. History is capped (e.g. the newest 5 000 messages), trimmed the same way on every device.
  - Clickable links, a copy button per message and the unread dot, as now.
- Sending a file has a **Keep for the room** switch, remembered per device:
  - **Send once**: goes to members online now and is held in memory for this page, as today. Everyone's timeline lists the name; those who didn't get it see "Not kept".
  - **Keep for the room**: the sender and every receiver store it in OPFS. It is named by a hash of its contents, so a copy from any member can be checked.
  - A newcomer, or a member who was away, taps **Open** or **Download**, and the file comes from any online member who has it. If nobody online has it: "Not available right now — *name* has it".
  - A storage limit per device in Settings (e.g. 2 GB by default): the oldest kept files are dropped first, and the timeline still lists them.
  - Any member can **Remove from room**: the entry is marked removed and every device deletes its copy.
- Viewer, opened from the timeline, with nothing saved to disk:
  - Images, video and audio in the browser's own elements, when the browser can decode the format (`canPlayType`, image decoding).
  - PDF: the browser's built-in viewer on desktop. Android Chrome has none, so pdf.js there (vendored, loaded on first use).
  - Text and code: a read-only CodeMirror from the editor bundle with syntax colours, plus **Open as shared document**.
  - Anything else: Download and Share.
  - Received HTML is never rendered and scripts never run: HTML shows as source, and SVG only through `<img>`.

**Tricky points**
- WebCrypto can't hash a stream, and multi-GB files don't fit in memory. Hash fixed-size parts (e.g. 4 MB) as they are read and name the file by the hash of the part hashes. A download can then check each part as it arrives.
- OPFS quota: check `navigator.storage.estimate()` before keeping, and request `navigator.storage.persist()` so the browser doesn't evict kept files.
- When several members fetch from one phone, serve them one at a time.

**As built** (2026-09-24, app 0.10.1, `PROTOCOL_VERSION` 6 — after Slice 10)
- Transfer is now **Chat** (`app/tools/chat/`, tool id `chat`). A desktop layout saved with the old Transfer panel no longer matches the tools, so it falls back to the default once, with the Chat at the side.
- **Timeline** (`timeline.js`) in the room's own Y.Doc (`app/roomdoc.js`, IndexedDB `peerkit.room:<room ID>`), synced over a new channel `room` by the editor's provider, which moved to `app/docsync.js` and takes a channel. An array `chat` of messages (`{id, kind, from, name, time}` plus `text` or `file: {name, size, type, keep, hash}`), a map `held` (who keeps a copy of which file) and a map `removed`. Everything read from it is checked. Over 5 000 messages every device deletes the same oldest ones, and lets their files go.
- The document needs Yjs but not CodeMirror, so the editor bundle was split: `vendor/yjs.js` (0.1 MB) loads when the room opens and is in the service worker's install list, and `vendor/editor.js` (0.7 MB, as before) imports it instead of carrying its own copy.
- A newcomer gets the history with the normal sync. The page shows the newest 200 messages, with **Show earlier messages** above them. Links, the copy button, the unread dot and the "joined" / "left" lines are as before; those lines stay on this page only.
- **Files**: every file goes through one send sheet (the clip button, paste, drop, Android's share), which has the **Keep for the room** switch (remembered in `peerkit.chat`, on by default) and says who gets it.
  - **Send once**: to the members online, held in memory for this page. Everyone else's card says "Not kept".
  - **Keep for the room**: the sender reads the file once to store its own copy and compute its hash, then puts it in the chat; every receiver writes it to disk (OPFS, `peerkit-kept/<room ID>/<file id>`) and keeps it only if it matches. The hash is SHA-256 over the SHA-256 of each 4 MB part, computed as the bytes arrive.
  - A newcomer or a member who was away taps **Open** or **Download**: the file comes from a member online who keeps it (`want`, then `queued` or `none`, then the usual offer), and is kept here too. Each member answers requests one at a time. With nobody online: "Not available right now — *name* has it".
  - **Remove from room**: a bin icon on each file card, after a confirmation. Every device deletes its copy; the card says "Removed by *name*".
  - **Settings → Kept files**: the space for kept files on this device (500 MB to 20 GB, default 2 GB) and what they take now. The oldest kept files, of any room, are dropped first; the card says "Dropped from this device to free space" and offers the file again from whoever has it.
- **Viewer** (`viewer.js`), full screen, with Download and Share: images, video and audio when the browser can play them (`canPlayType`), PDF in the browser's own viewer where `navigator.pdfViewerEnabled`, else pdf.js, and text and code in a read-only CodeMirror with syntax colours and **Open as shared document** (the Editor gets it through a new `ctx.handOff`). Anything else: Download and Share. Received HTML shows as source and SVG only as an image. Every object URL gets a type chosen from the file name, never the sender's, and downloads are `application/octet-stream`, so nothing a member sends can open as a page of this site.
- pdf.js is `pdfjs-dist` 6.3.289, its **legacy** build: the modern one needs JavaScript that only the newest browsers have (`Uint8Array.prototype.toHex`). It draws pages onto canvases as they scroll into view. Its CJK font maps, standard fonts and JPEG 2000 decoder (4 MB more) are left out; see `vendor/README.md`.
- An offer must match its chat entry, and a device refuses an offer for a file it already has or is already receiving, so a bad copy can't overwrite a good one.
- `PROTOCOL_VERSION` → **6**: text no longer goes as `transfer` messages, so a version-5 device would neither see the chat nor be seen in it.
- Differences from the plan:
  - A kept file is stored under its chat entry id, not under its hash, so the sender can store and hash its copy in one read. The hash is in the entry, so every copy is checked all the same, whoever it comes from.
  - A download is checked once, at the end, against the hash, not part by part as it arrives: that needs no list of part hashes sent ahead. A bad copy is found only when it is complete, and nothing of it is kept.
  - The Keep switch is in the send sheet, not in the composer.
  - Messages can be sent with nobody else in the room: they wait in the history. So can kept files.
  - A message longer than 50 000 characters is refused, with a hint to send it as a file or open it in the Editor.
  - "Open" on a kept file that isn't here fetches it and then opens it.
- Tests: `node test/run.mjs chat` (62 checks) runs the Chat with real rooms on the fake network, five devices and a headless member: history, a photo sent once, kept files on every device, a newcomer fetching one after its sender left (byte for byte), the viewer for an image, a video, code, HTML and a PDF, a forged copy that fails its hash, a long history, removing a file, the storage limit, trimming. `node test/run.mjs vendor` (5 checks) checks that the two bundles share one Yjs and that pdf.js opens a PDF. The app test's chat now runs through a room document on the headless member. 298 checks in all.
- Checked in Node, not in a browser: the checklist below is still to do.

**Checklist**
- [ ] A message sent before a device joined is in its history after it joins.
- [ ] A photo sent "Send once" opens in the viewer for members who were online; a newcomer sees its name marked "Not kept".
- [ ] A video sent "Keep for the room"; the sender leaves; a newcomer opens it from another member.
- [ ] A PDF opens on the laptop and on the phone; a `.js` file shows with syntax colours; an `.html` file shows as source.
- [ ] Remove a kept file: it disappears on all devices, and storage use goes down.
- [ ] Reach the storage limit: the oldest kept file is dropped, and the timeline says so.

### Slice 10 — Desktop layout

**Why:** a laptop screen fits several tools at once: watch a stream while chatting, or edit next to the chat.

**Build**
- Vendor `dockview-core` (MIT, no dependencies; pinned at least 21 days old, 8.2.0 at the time of writing) with its licence, recorded in `vendor/README.md`.
- On wide screens with a mouse (e.g. `(min-width: 900px) and (pointer: fine)`), tools open as dockview panels: tab groups, drag a tab to split in any direction, resize, maximize and floating panels.
  - The default layout is a main area (Editor, streams) and a side column with Chat and the members.
  - The layout is saved per device (`peerkit.layout`, versioned), with **Reset layout** in the menu.
- Phones and narrow windows keep the bottom tabs. Switching between the two layouts keeps every tool's state, without remounting.
- Tool interface: a tool can open several panels, e.g. one per document or per stream, through `ctx.openPanel({id, title, el})`. On phones these become switchable views inside the tool.
- Unread dots work in both layouts, and `activate()` brings the panel to the front on desktop.

**Tricky points**
- Moving an element in the DOM reloads an iframe and pauses a video. Use dockview's always-rendered panels for iframes (the NES later), and call `play()` on videos after a move.
- CodeMirror needs `requestMeasure()` after its panel resizes or becomes visible.

**As built** (2026-09-23, app 0.10.0, `PROTOCOL_VERSION` 5 — built before Slice 9, on request)
- `vendor/dockview.js` is dockview-core **8.2.0** (the newest at least 21 days old; 8.3.x was too new), its ES module build as is. The npm package ships its stylesheet only inside the UMD build, which injects it on load, so `vendor/dockview.css` is that stylesheet taken out as is (recipe in `vendor/README.md`). Both load with `import()` / a `<link>` only when the window is wide, and start loading while the room is being found, so a phone never downloads them. Like `vendor/editor.js`, they stay out of the service worker's install list and are cached on first use.
- `app/ui/layout.js` (`ToolLayout`) owns where the tools are shown. Each tool gets one element for its whole life. `(min-width: 900px) and (pointer: fine)` puts those elements into dockview panels; a narrower window, or a phone, puts them back under the bottom tabs. Switching (resizing the window) moves the elements and never mounts a tool again. Videos that were playing are started again after a move, because moving a media element pauses it.
- Panels use dockview's `always` renderer: a tool in a tab that isn't in front stays in the page (hidden, not removed), as with the bottom tabs, so a stream keeps its sound and the chat keeps its scroll position.
- The default layout: **Stream** and **Editor** as tabs in the main area with the Editor in front, and **Transfer** — the chat until Slice 9 — in a 360 px column on the right.
- Each group has two buttons at the right of its tabs: **Float** / **Put back into the layout** (dragging a tab with Shift held floats it too) and **Maximize** / **Restore**. Tabs have no close button: a tool can't be closed, only moved.
- The layout is saved per device (`peerkit.layout`, version 1) 300 ms after each change and when the page closes. A saved layout that holds other tools than the ones this version has (or doesn't load) is ignored, and the default is used. **Reset layout** is an icon in the top bar, shown only while panels are in use.
- `ctx` for tools is unchanged. `activate()` brings the panel to the front of its group (and ends a maximize that hides it); `notify()` puts a dot on the panel's tab; `visible()` and `onShow()` follow what can really be seen — dockview reports the panels of a group hidden by a maximize as visible, so the group is asked too.
- The panels take their colours from the app's own variables (`.dockview-theme-peerkit` in `styles.css`), so light and dark follow the system. Toasts sit above floating panels.
- Differences from the plan:
  - **`ctx.openPanel()` is not built.** Nothing opens a second panel yet; it comes with its first user, Slice 11's one panel per stream.
  - The members stay in the room bar above the panels, with the voice row, instead of a people panel in the side column: one place for them in both layouts.
  - "Reset layout in the menu": there is no menu, so it is a top-bar icon.
  - The side column holds Transfer until Slice 9 turns it into the chat.
- Tests: a third mode of the jsdom app test, `node test/run.mjs desktop` (24 checks): the default layout, the editor loading because it can be seen, maximize hiding the chat so a message marks its tab, a stream bringing its panel to the front, float, the layout saved, narrowing to tabs with the same elements (not remounted), widening back to the saved layout, Reset layout, and a saved layout for other tools falling back to the default. The pwa test allows `vendor/dockview.js` outside the install list.
- Checked in Node, not in a browser: dragging, sizes and how it looks are for the checklist below.

**Checklist**
- [ ] On the laptop: a stream in the main area and the chat at the side, both live.
- [ ] Drag the editor next to the stream, resize, maximize one, then restore it.
- [ ] Reload: the layout is the same; Reset layout brings back the default.
- [ ] Narrow the window: tabs come back, the stream keeps playing and the editor keeps its cursor.
- [ ] The phone looks and works as before.

### Slice 11 — Streams to the room

**Why:** anyone can show their camera or screen to the whole room, and several people can share at once.

**Build**
- A new stream is announced to the room, and every member receives it by default. A viewer who closes it stops the sending to that viewer only.
  - A member can share one camera and one screen at the same time.
  - The sender makes one media call per viewer. Camera switch, mic and resolution apply to all of them (`replaceTrack`, `applyConstraints`).
  - A member who joins later gets the streams already running.
  - The sender sees the number of viewers and the upload rate (from `getStats()`), with a warning when the upload can't keep up. Each viewer's `maxBitrate` is lowered before the picture breaks up.
- Viewing: each stream is its own panel on desktop (Slice 10); on phones the Stream tab shows a grid with tap to focus.
- The 30 s pause and re-call after a dropped link works per viewer. The screen-audio music settings apply to every call, as today.

**Tricky points**
- A 1080p screen share takes about 1.5–3 Mbit/s per viewer, so 5 viewers need up to about 15 Mbit/s of upload. Viewers behind the TURN relay also use the VPS's bandwidth.
- A phone encoding several copies of its camera gets hot: lower the default resolution when it has more than 2 viewers.

**Checklist**
- [ ] The laptop shares its screen; three other devices see it.
- [ ] The phone shares its camera while the laptop shares its screen: everyone sees both.
- [ ] A device joins while a stream is running: it sees the stream within a few seconds.
- [ ] One viewer closes a stream: the others keep it, and the sender's viewer count drops.
- [ ] The sender switches camera: all viewers see the new camera without a restart.
- [ ] The sender's upload is limited (e.g. a phone hotspot): the warning shows, and the picture gets softer instead of freezing.

### Slice 12 — Pointer and drawing on streams

**Why:** viewers can show exactly what they mean on a shared screen: "click here", "this line".

**Build**
- On a stream, **Point** shows the viewer's pointer with their name and colour to everyone watching, including on the sender's preview.
- **Draw** makes strokes that fade after a few seconds; **Clear** removes them for everyone at once.
- Positions are fractions of the video picture, not of the element, so letterboxing and different screen sizes line up.
- Sent over ctl to the members watching, at most 30 updates per second.

**Tricky points**
- A web page can't draw over the sender's real desktop: the sender sees the marks only on its PeerKit preview. The UI says so.

**Checklist**
- [ ] The phone points at a spot on the laptop's shared screen: the laptop preview and the other viewers show it in the same place.
- [ ] A portrait phone viewing a landscape screen: the pointer still lands in the right place.
- [ ] Strokes fade by themselves, and Clear removes them for everyone.

### Slice 13 — Shared whiteboard

**Why:** sketching together, which text and streams can't do.

**Build**
- A **Whiteboard** tool: boards live in the room Y.Doc, with a list like the editor's documents.
- Pen with pressure (Pointer Events), highlighter, eraser and colours; undo and redo of your own strokes (Y.UndoManager); pan and pinch zoom.
- Strokes are simplified before they're stored. Other members' pens show live through awareness.
- Export as PNG, and send it to Chat.

**As built** (2026-09-24, app 0.13.0, `PROTOCOL_VERSION` 6 — after Slices 9 and 10 and before 11 and 12, on request, with images from the clipboard added to it)
- **Whiteboard** (`app/tools/whiteboard/`, tool id `whiteboard`): a fourth tab on phones; on a wide screen a panel in the main area beside Stream and Editor. A desktop layout saved before it now keeps its arrangement, and the Whiteboard joins the main area as a tab behind the one in front: adding a tool no longer resets a saved layout.
- **Boards**: a list like the Editor's documents (the board button, **New board**, the name, **Delete** for everyone) and **Clear**, which undo brings back. Each device reopens the board it last had open in the room.
- **Tools** in a bar under the board: **Select and move**, **Pen**, **Highlighter** and **Eraser** (keys V, P, H, E); a colour and size popover (8 colours and 3 sizes, one choice for the pen and one for the highlighter, remembered on the device in `peerkit.whiteboard`); **Undo** and **Redo** at the top (and Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y).
  - The pen follows a stylus's pressure; a mouse and a finger draw evenly. The highlighter is see-through and blends with what is under it.
  - The eraser takes the strokes and images it touches, shown faded until it lifts; one gesture is one undo step.
  - Select: tap to select, drag to move a stroke or an image, drag an image's corner to resize it in proportion, Delete (or the bin) to remove.
- **Pan and zoom**: two fingers, the wheel and Ctrl+wheel (a touchpad pinch), Space or the middle button, and **Show the whole board**. A pinch draws nothing: a stroke that began less than 250 ms before the second finger landed is dropped. Once a stylus has drawn on a device, fingers pan there, so a palm on the screen draws nothing.
- **Live**: a stroke being drawn reaches the others through awareness (up to 15 updates a second), and so do mouse pointers, with names; the finished stroke is simplified and stored in one change. Chips at the top show who is on the board.
- **Images from the clipboard**: Ctrl+V (⌘V) on the board, or with nothing else focused, pastes a copied image or screenshot; a paste into a text field stays there. The **Add an image** button has **Paste image** (the Clipboard API, which asks once for permission on Android) and **Choose image**, and an image can be dropped on the board. It lands in the middle of the view (a drop, where it was dropped), a screenshot at the size it had on screen, at most 60 % of the view, and is selected, ready to move or resize.
  - Images are stored in the board document, so they sync, merge and undo like strokes. Each is drawn again before it is stored, which drops a photo's metadata (its location among it) and applies its rotation, at most 2560 px on its long side, and encoded to 1 MB or less: PNG when that fits (screenshots, drawings), else WebP (JPEG where the browser can't write WebP), made smaller until it fits. At most 40 images per board.
  - An image from a member is decoded with `createImageBitmap` from its bytes alone, which reads raster formats only: nothing in it runs, and an SVG never renders.
- **Export**: the board's options have **Send to Chat** (the Chat's send sheet opens with `<board name>.png`, Keep for the room as for any file; `ctx.handOff`, which the Chat now takes) and **Download PNG**: the whole drawing on white with a margin, two pixels per board unit (4096 px at most).
- The board is white paper in both colour schemes, so images and ink look the same on every device.
- `PROTOCOL_VERSION` stays **6**: a device without the whiteboard ignores ch `board`, and syncs the boards once it has one.
- Differences from the plan:
  - **Boards are not in the room Y.Doc** but in a Y.Doc of their own (`peerkit.board:<room ID>` in IndexedDB, ch `board`): images can make it megabytes, and a newcomer would wait for all of them before seeing the chat history, which arrives in one piece. `RoomDoc` now takes a database name, a channel and an awareness. The board document loads when the tab is shown or when a member starts syncing it. "Leave and forget" deletes it as well.
  - The eraser removes whole strokes, not the part it passes over.
  - Simplification keeps a point where the pressure changes as well as where the line bends, so a stylus stroke keeps its taper.
  - Images, the pointers of the others and Select were not in the plan.
- Tests: `node test/run.mjs whiteboard` (91 checks) runs the Whiteboard with real rooms on the fake network: three devices and a headless member, with a canvas that records what is drawn and images that carry their size in their first bytes. Drawing and the stroke in progress on the others, three at once, simplification, pressure, undo and redo of one's own strokes only, the highlighter, colours and sizes, the eraser and its undo, a pinch, a palm after a stylus, drawing offline and merging, a pasted screenshot, a paste into a text field, moving and resizing, Paste image with a large photo and with no image, Delete, a file that isn't an image, a drop, the board list, rename and delete, Send to Chat and the exported PNG, Download, forged items and awareness, and the unread mark. The app test opens the Whiteboard tab and makes a board; the desktop test has the new default and a layout saved before the Whiteboard. 396 checks in all.
- Found while testing: two devices that join at the same moment were never linked to each other. Fixed in 0.13.1 (see **Done outside the slices → Two newcomers at once**); the test's phone and tablet now join together.
- Checked in Node, not in a browser: the checklist below is still to do.

**Checklist**
- [ ] Three devices draw at once, and the strokes appear on all of them while being drawn.
- [ ] Undo on one device removes only its own stroke.
- [ ] Draw while offline, then reconnect: the strokes merge.
- [ ] Pinch zoom on the phone doesn't draw.
- [ ] The exported PNG matches the board.
- [ ] A screenshot copied on the laptop and pasted with Ctrl+V shows on the phone, sharp enough to read when zoomed in.
- [ ] On the phone, an image copied in Chrome goes onto the board with Add an image → Paste image.

### Slice 14 — Phone as controller

**Why:** gyro and gamepad become a reusable input layer, the foundation for the party games.

**Build**
- `protocol.js`: an input message `{ch:'input', slot, seq, t, buttons:<bitmask>, axes:[...], quat:[x,y,z,w]?}`.
  - Button and axis order follows the **Standard Gamepad** mapping (17 buttons, 4 axes), so emulators can use it without translation.
  - Input goes over a separate **unreliable, unordered** DataConnection (`reliable:false`). Button *edges* are also sent on the reliable channel so a press is never lost.
- **Controller tool** (phone):
  - Layouts: NES pad (D-pad, A, B, Select, Start) and Motion (big trigger button + gyro).
  - Multitouch, `touch-action:none`, vibration on press.
  - Fullscreen, landscape orientation lock, Wake Lock.
- Gyro:
  - Use `AbsoluteOrientationSensor` on Android Chrome (at 60 Hz), falling back to `deviceorientation`.
  - A "Recenter" button stores the reference quaternion.
  - Send rate is capped at 60 Hz and only sends on change.
- A physical gamepad connected to the phone (Gamepad API) is forwarded with the same message format.
- **Monitor tool** (host): visual pad with lit buttons, a 3D orientation cube or arrow, input latency, and a packets/sec counter.
- Host-side API for games: `session.input.on('state', (slot, state) => …)` plus a `getPad(slot)` snapshot shaped like a `Gamepad` object.
- In a room, the "host" is the member whose device runs the game or tool, and any other member can send it input. This is the remote control of a PeerKit tool from the rooms decisions; the operating system itself is never controlled.

**Checklist**
- [ ] Phone NES layout in landscape: pressing D-pad/A/B lights them instantly on the laptop monitor.
- [ ] Pressing two buttons with two thumbs registers both.
- [ ] Rotate the phone: the monitor's orientation cube follows smoothly; Recenter resets it.
- [ ] Latency figure on the monitor stays low (~tens of ms on the same Wi-Fi).
- [ ] Screen doesn't sleep while the controller is open; vibration on press works.
- [ ] A USB/Bluetooth gamepad connected to the phone shows on the laptop monitor.
- [ ] Rapid tap of a button is never missed, even under packet loss.

### Slice 15 — NES (two players)

**Why:** the first real game on the input layer. A laptop or TV runs the emulator; a phone is the second pad, either on the couch or remotely with the picture streamed to it.

**Build**
- In a room, "host" below means the member that runs the emulator, and "guest" any other member.
- Emulator: the FCEUX Emscripten build from the local `4player-nes` folder, copied to `vendor/fceux/` (js + wasm, renamed) with its GPL-2.0 licence and a source link. Only the build is reused: Kosmi's React glue (`nesparty.js`) is a reference, not copied.
- It runs in a same-origin iframe (`app/tools/nes/frame.html`), because the build lives in globals (`Module`, `FS`, `SDL`, `window.neswasm`) and can only be unloaded with its page.
- What the build offers (checked in the demo):
  - `Module.arguments = ['--no-config', '1', '/romfile']`; the ROM goes in through `FS.createDataFile('/', 'romfile', bytes)` between `addRunDependency('rom')` and `removeRunDependency('rom')`.
  - `_setGamePadValue(pad 0–3, button, pressed)`, buttons `[A, B, Select, Start, Up, Down, Left, Right]`; `_enableFourScore()`.
  - `_saveState()` / `_loadState()` with a state file in `FS` (path to confirm; the demo used `/DUMP.frz`). No battery-save (SRAM) export.
  - Sound goes only to `window.SDL.destination`, which the host sets to a `MediaStreamAudioDestinationNode`; the host also routes it to its speakers through a gain node for Mute.
  - The main loop runs on `requestAnimationFrame` with no timing, so on 120/144 Hz screens games run 2× fast (the demo asked you to lower the refresh rate). Fix: in the iframe, replace `requestAnimationFrame` with a scheduler that runs frames at the NES rate (60.1 Hz) and skips or repeats display frames.
- Host (NES tab):
  - Open a ROM from a local file; no ROMs are shipped and there's no online list. The last ROMs are kept in IndexedDB by hash for "Continue".
  - Canvas scaled with `image-rendering: pixelated`, full screen, Pause, Reset, Mute.
  - Pads: keyboard (remappable, remembered) and the Gamepad API. Player 1 is the host by default; players can be swapped.
  - Save state / Load state in slots per ROM (IndexedDB), plus export/import as a file.
- Guest (NES tab), two modes:
  - **Controller only**: the Slice 14 NES layout, for playing in front of the host's screen.
  - **Remote play**: the host streams the canvas and sound (media call kind `nes`, music audio from Slice 4) with the touch pad over it.
- Input: the Slice 14 input channel; the host maps each slot to a pad and calls `_setGamePadValue`.
- When the guest drops, the game pauses; it continues on reconnect.

**Checklist**
- [ ] Load a legally obtained ROM on the laptop: picture and sound at the right speed on a 60 Hz and on a 120 Hz+ screen.
- [ ] Phone in Controller only: player 2 responds with no noticeable lag; the laptop keyboard controls player 1.
- [ ] Phone in Remote play: sees the game with sound and plays player 2.
- [ ] Save state, keep playing, load state: back to the saved moment, also after a reload.
- [ ] Stop the game or leave the tab: the emulator unloads (no sound, CPU drops).
- [ ] A USB/Bluetooth gamepad on the laptop plays player 1.

### Slice 16 — Party games in a room

**Why:** several phones in one room play on one screen, which is the prerequisite for multiplayer games.

**Build**
- The member that runs a game (the NES, later a game module) shows a lobby: player slots with each member's colour and name. Members pick a free slot on their phone; the game screen can swap slots.
- Reconnecting keeps a player's slot, by device ID.
- The Monitor tool shows every slot at once.
- NES: Four Score on; slots 1–4 map to pads 1–4. Remote players watch the game as a room stream (Slice 11) with the touch pad over it.
- Kicking players and locking the room are gone from this slice: rooms have no removal. Starting a game in a new room is the way to play with a different group.

**Checklist**
- [ ] Two phones in the laptop's room take slots 2 and 3; the lobby shows their colours and names.
- [ ] Both controllers show separately on the monitor.
- [ ] Reload one phone: it returns to the same slot.
- [ ] Four devices play a 4-player NES game (Four Score), each with its own pad.
- [ ] A member far away plays from the stream with the touch pad over it.

### Slice 17 — Game module API and more games

**Why:** gives new games a template, and proves the input layer is good enough for motion games too.

**Build**
- `games/<id>/game.js` interface: `{ id, title, players:{min,max}, controllerLayout, mount(el, input), unmount() }`. The host lists games in a Games tab, and the phones switch to the declared layout automatically.
- The NES tool from Slice 15 moves behind this interface.
- **Swing test** (Wii-tennis-like): swing speed and direction from the quaternion's angular velocity, shown as a meter per player. This is used to tune the gyro pipeline.

**Checklist**
- [ ] Games tab lists "Swing test" and "NES"; starting one switches phones to the correct layout.
- [ ] Swing test: a hard swing and a soft swing give clearly different readings; left/right direction is correct.
- [ ] Leaving a game returns phones to the normal controller.

---

## Postponed

Put on hold on 2026-09-14 with no date; they come back once it's clear where they fit. The plans are kept as they were.

### Record incoming stream (was Slice 5)

**Why:** the recorder demo becomes useful. You can capture what the other device shows, such as a phone camera on the laptop or a laptop screen on the phone.

**Build**
- The receiver view gets a Record button with a timer and a size estimate.
- MediaRecorder:
  - Pick the first supported mime type from `video/mp4;codecs=avc1`, then `video/webm;codecs=vp9`, then `video/webm`.
  - Use `timeslice` of 1 s so a dropped stream still leaves a usable file.
- When recording stops:
  - The file appears in a "Recordings" list (this session only, in memory) with play, download and share.
  - Offer "Send to other device" through the Transfer tool.
- If the stream ends mid-recording, stop and keep what was captured.

**Checklist**
- [ ] Record 30 s of phone camera on the laptop; the file plays with audio in the browser and a desktop player.
- [ ] Record laptop screen on the phone; download/share from phone works.
- [ ] Stop the stream on the sender mid-recording: the partial recording is kept.
- [ ] "Send to other device" delivers the recording via Transfer.

### Unlimited-size files on Chrome (was Slice 6)

**Why:** you can move very large videos and disk images without the browser tab running out of RAM.

**Build**
- A receiver option "Save directly to disk", shown only when supported:
  - Desktop Chrome: `showSaveFilePicker` prompt when the offer arrives, then chunks stream into a `FileSystemWritableFileStream`.
  - Android Chrome: write to OPFS (`navigator.storage.getDirectory()`), then offer Download/Share. Check `navigator.storage.estimate()` for free space before accepting.
- Resume: if a transfer breaks off, the receiver reports the byte offset it reached. After reconnect, the sender continues from that offset. The file is identified by name+size+lastModified.
- Show an ETA and transfer speed. Warn before accepting a file over about 2 GB when only the in-memory mode is available.

**Checklist**
- [ ] Desktop Chrome: receive a >4 GB file with "Save directly to disk"; tab memory stays flat; the file hash matches (`shasum`).
- [ ] Android Chrome: receive a 3 GB file via OPFS; low-space case shows a warning before starting.
- [ ] Kill Wi-Fi mid-transfer, restore: transfer resumes from where it stopped, not from zero.
- [ ] Browser without support: option is hidden, and a >2 GB offer shows the warning.

---

## Done outside the slices

### Installable app and Android share target (2026-09-23, 0.7.1)

**Why:** an installed PeerKit opens from the home screen without the browser chrome, and — the real point — Android only offers an app in its share sheet once it is installed. "Share → PeerKit" from the gallery or a file manager now puts a photo or a file straight into the open room.

**As built**
- `manifest.webmanifest`: relative `start_url` and `scope` (so a subdirectory deploy works), standalone, 192/512 icons and a maskable one rendered from `icon.svg`, and the `share_target`.
- `sw.js`, a classic service worker (Firefox has no module workers):
  - **Install:** it is what makes the browser offer "Install app" at all. `SHELL` lists the app's files; `vendor/editor.js` (0.7 MB) is left out and cached when the Editor tab is first opened.
  - **Offline:** network first, cache as fallback, so an update is never held back by the cache; a navigation with no network falls back to the cached start page. The cache is named after `APP_VERSION`, and older ones are deleted on activation.
  - **Share:** the share target is a POST, which a static host cannot answer. The worker takes it, puts the files and the text in the `peerkit-share` cache and redirects to `./?share=1`.
- `app/share.js` reads that cache once, `app/pwa.js` registers the worker and keeps Chrome's install prompt for the **Install** section in Settings.
- The share is taken out of the cache only when a room is open, so it survives the reload that opening a room does. With no room the start screen says what is waiting, with **Discard**; in a room the Transfer tool asks "Send this file?" and sends it to everyone once someone else is there.
- Tests: `node test/run.mjs pwa` (26 checks) runs the real worker over a fake Cache Storage and then reads it back with `app/share.js`, so both sides are checked against each other; it also fails when a new app file is missing from `SHELL`. The jsdom tests cover the banner on the start screen and a shared file reaching a member.

**Checklist**
- [ ] Android Chrome on the GitHub Pages address: Settings → Install (or the browser menu) installs PeerKit, and it opens from the home screen with no address bar.
- [ ] Share a photo from the gallery to PeerKit with a room open: the sheet lists it, **Send** delivers it to the other device.
- [ ] Share a link from Chrome to PeerKit: the text lands in the composer.
- [ ] Share a photo with no room open: the start screen says it is waiting, and it is still sent after creating a room.
- [ ] Turn off Wi-Fi and mobile data and open the installed app: the start screen loads (it can't reach the signaling server, which is expected).
- [ ] After a deploy, reloading twice picks up the new version (the version in Settings → About changes).

### Sharing before anyone arrives (2026-09-23, 0.8.1)

**Why:** the Share camera and Share screen buttons were dead while you were alone in the room, which is exactly when you set a share up — you make a room, start the screen share, then send the invite.

**As built**
- Capture starts with no viewer: the preview runs, the bar says "Ready to share your screen — waiting for someone to join" with a grey dot instead of the live one, and Stop works as usual.
- The first member to arrive gets it (`onLinkUp` fills in the viewer, calls and says "Sharing with *name*"). With several already in the room the picker is unchanged.
- The stream is a `stop` message to one member, so it is only sent when there is one; the resume bar after a reload no longer waits for company either.
- Covered in the jsdom app test: the buttons work while alone, the bar says it is waiting, and a newcomer receives the camera call.

### Nobody could be heard (2026-09-23, 0.8.2)

**Why:** two devices joined voice, each saw the other counted in ("2 in voice") and its own badge lit up with its own voice — and neither heard a sound, with nothing in the console. The bar counted a member as soon as it said it was in voice, whether or not a single byte of audio had ever arrived from it, so there was no way to tell where it stopped.

**As built**
- **It says where it stops.** A member in voice who cannot be heard is marked `waiting` (a dimmed microphone on the chip) instead of `on`, the voice row adds "connecting…", and the voice sheet says per member "Listening only", "No call yet", "Connecting…" or "No sound coming through". `voice.waiting` and `voice.statusOf(peer)` are what the UI reads.
- **"Can be heard" is not "is in voice".** A track handed over by a call is `muted` until the first media comes through it and fires `unmute` when it does, so that, not the arrival of the call, is what ends the wait. A call that connects and then carries nothing was the one failure the count could not see — and it is what the report describes.
- **It keeps trying.** A call that connects but never delivers audio is closed and dialled again after 10 s (a listener sends none, so it is never waited for); a pair left without a call because the signaling server was away calls as soon as the room reports it is back; and the redial no longer gives up for good after five tries — it slows down to one every 15 s while both are in voice. When a call is given up on, the console gets the ICE, connection and signaling state of it, which is the only clue a stalled call leaves.
- **A silence that was in the code**: `analyse()` handed the `<audio>` element's own stream to an `AnalyserNode`. Chrome gives a remote stream to a media element **or** to Web Audio, not both, so the sound went into the Web Audio graph, which connects to nothing. The levels now read a clone of the remote track (`tap()`), the clone is stopped with the call, and this device's own microphone is still read straight, because nothing is playing it. That one makes a member silent *while* the speaking mark works, which is not what was reported, so it was not the whole story — but it would have been the next bug.
- `test/voice-test.mjs` grew from 27 to 43 checks: a fake Web Audio that reads a level, the copy the analyser gets against the stream the element plays, the copy stopped with the call, `waiting` / `statusOf` before and after a call comes up, a call that stops carrying media and comes back without being remade, the redial after a call with no audio, and the pair that calls by itself when signaling returns.
- Still to find out on real devices: where the voice sheet says it stops — "No call yet", "Connecting…" or "No sound coming through" — and what ICE state the console prints when a call is given up on.

### A share that outlives its viewer (2026-09-23, 0.8.3)

**Why:** a screen share started in an empty room went to the first arrival, but when that viewer left it said "Paused until *name* is back…" for 30 s and then stopped the capture, with "Your screen sharing stopped when the page reloaded or the connection dropped". To show the screen to them again you had to pick the window again — the very setup 0.8.1 was meant to spare.

**As built**
- The 30 s grace still belongs to the device that dropped: if it comes back in time (after a reload too), it gets the stream at once and nobody else can take it.
- After the grace the capture keeps running instead of stopping: the bar says "*name* left — waiting for someone to join", and the next member to arrive gets the same stream, that device included, as in 0.8.1. Only Stop, the browser's own "Stop sharing" and the viewer's ✕ end it.
- The "stopped" offer with **Resume** now appears only after this page reloads (the capture dies with the page), and says so.
- Not changed: with others still in the room, a waiting stream goes only to a newcomer. Handing it to someone already there is Slice 11's "every member receives it".
- Covered in the jsdom app test, where the Stream tool's own timers run 100× faster: the viewer leaves, the bar pauses for it, then waits for anyone with the capture still on; the same device coming back gets the same stream id.

### Two newcomers at once (2026-09-24, 0.13.1)

**Why:** found while testing the whiteboard. Two devices that joined at the same moment were each welcomed by the anchor before the other was a member, so neither was on the other's list, and nothing made them dial each other later. The documents, the chat and the boards still reached both through the others, but voice, streams and files sent once never passed between the two.

**As built**
- Members already announce their direct links (`links`, for the Editor's forwarding). A member that others list and this device isn't linked to is now dialed, by the lower peer ID of the two, as for redials. It waits until the lists have been still for 3 s, so a newcomer's own dials arrive before anyone dials it back; a dial that is already on its way in counts as a link.
- A dial that fails is redialed up to 6 times, as before, and then left alone until the lists change again, so two devices that can't reach each other don't try forever.
- A peer ID that said `bye`, was rejected (a different app version, a failed handshake) or reloaded under a new ID isn't dialed because someone's list still names it.
- No message changed: `PROTOCOL_VERSION` stays 6. A device on 0.13.0 doesn't dial on its own but answers a dial.
- Tests: the room test grew from 30 to 36 checks: two newcomers at once end linked with one dial from the lower peer ID, a member that left isn't brought back by a stale list, and two members that can't reach each other stop after 7 dials. The whiteboard test's phone and tablet now join together (90 checks, one fewer: the wait for the phone alone is gone). 401 checks in all.

**Checklist**
- [ ] Open the room link on two phones at the same moment while a laptop holds the room: within a few seconds both phones list each other, and voice works between them.

### Voice stuck on "connecting…", a Mute that needed two taps, and whiteboard lines that vanished (2026-09-25, 0.13.2)

**Why:** reported after a test on phones: the first time two people joined voice it said "2 in voice · connecting…" and they couldn't hear each other until they tried again; Mute often needed a second tap; and sometimes a whiteboard line drawn with the mouse disappeared when the button was released.

**As built**
- **Mute needed two taps.** The room bar was built again from scratch on every ping answer (every 2 s per member) and every time someone started or stopped speaking, which while people talk is several times a second. A tap that began on one Mute button and ended on its replacement was no click at all. The bar is now made once and updated in place; the voice sheet keeps its rows too, so a volume slider can be dragged while someone speaks.
- **"Connecting…" for good.** When one side of a call hears nothing for 10 s it gives up and closes its end, but peerjs never tells the other end, so the side that dials kept a dead call, and it only dials when it has none. If it could hear the other (one-way audio), it had no reason to give up either: both sat on "connecting…" until someone left voice. The side that gives up now sends `hangup` with the call's ID, and the pair is dialled again a second later. A listener that takes the microphone does the same. A call to a device that isn't in voice (any more) is answered with its state, so the caller stops.
- The fake network in the tests closed both ends of a call when one was closed, which is why nothing caught this; it now behaves like peerjs.
- What made the first call silent is not known: one-way audio at the start of a call happens with a microphone that is busy or not yet delivering (on Android the first permission prompt, or a phone call in progress). Now it costs about 11 s instead of a rejoin. `(failed) net::ERR_CACHE_MISS` in the console is the browser's, not PeerKit's.
- **The whiteboard line.** A second test showed it more closely: the line vanished on both screens the moment the mouse button came up, about one line in five, and Chrome's console (`monitorEvents` on `.wb-stage`) showed `lostpointercapture` before `pointerup`. The board took a lost capture for a cancelled press and dropped the stroke, so it was never stored and the others' copy of the stroke in progress went too. Why Chrome takes the capture away first is not known (nothing in PeerKit moves the board). A lost capture now ends the gesture as a release: the stroke is kept, and the `pointerup` after it does nothing. A `pointercancel` (the browser taking a touch over) still drops it. It was neither the connection nor Yjs: the drawing device stores the stroke in its own copy before sending anything, and 150 strokes drawn with random timing all arrived.
- If two phones joined at the same moment on 0.13.0, they weren't linked to each other at all (fixed in 0.13.1), and voice between them could only say "connecting…". That fits "when one left and the other connected, there were no such problems".
- Tests: the voice test grew from 43 to 49 checks (a one-way call given up on by the side that answered, a stale hangup that leaves the new call alone, a listener taking the microphone), the app test from 57 to 60 (the Mute button and the voice sheet's slider survive a redraw; Leave voice hidden outside voice), the whiteboard test from 90 to 94 (a capture lost just before the release keeps the stroke; a cancelled touch still draws nothing). 414 checks in all.

**Checklist**
- [ ] While someone talks, Mute and Unmute react to the first tap, on the phone and on the laptop.
- [ ] Open the voice settings sheet while someone talks: the volume slider can be dragged.
- [ ] Two phones join voice for the first time on that phone (the permission prompt appears): if it says "connecting…", it sorts itself out within about 15 s without leaving voice.
- [ ] Draw on the whiteboard with the mouse while a phone watches, several times: every line stays on both screens.

### Monaco in the Editor (2026-09-26, 0.13.3)

**Why:** people know Monaco, the editor of VS Code, much better than CodeMirror, but Monaco is awkward on a phone. So there is a choice.

**As built**
- Settings → Editor: **Automatic** (Monaco with a mouse, CodeMirror on a touch screen; the default), **Monaco** or **CodeMirror**. It is a setting of this device (`peerkit.editor`, `engine`), and changing it moves the open document to the other editor at once, with its cursor and undo history.
- Members with different editors are in the same documents and see each other's cursors and names: Monaco's binding (`app/tools/editor/monaco-binding.js`, PeerKit's own) uses the awareness field of CodeMirror's. `y-monaco` wasn't used: it has another field and an undo that would take back the others' edits.
- Undo in Monaco is the document's shared-editing undo (only this device's edits), as in CodeMirror; Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y are bound to it. The toolbar keys on a phone, Search, the document options (language, text size, wrapping) work with both.
- Monaco is vendored: `vendor/monaco.js` (3.5 MB, 0.9 MB compressed), `monaco.css` and `monaco.worker.js`, built from `monaco-editor` 0.56.0 in `vendor/editor-src` (the newest version at least 21 days old). Syntax colouring for every language of the Editor, word suggestions, find and replace, multiple cursors, folding, the command palette (F1). No language services (TypeScript errors and IntelliSense, CSS, HTML, JSON checks): they are megabytes more and would need a worker each. The minimap is off, since the Editor is often a narrow panel.
- A device loads only the editor it uses, the first time a document opens in it; the service worker caches it then. The data itself now needs only `vendor/yjs.js`, so a device that shows documents in Monaco never fetches CodeMirror (the chat's viewer still uses CodeMirror for code).
- Monaco takes its colours from the app's, light and dark.
- Tests: a new jsdom test, `monaco` (38 checks): a member in Monaco and one in CodeMirror typing at once, multi-line edits, undo and redo that leave the other's edits alone (Ctrl+Z included, after a switch, where Monaco's own undo would have nothing), cursors and names both ways, a hostile name and colour, a forged cursor, the document options, switching editors and back, offline edits merging. The vendor test checks the Monaco bundle (no Yjs in it, a classic worker, the icon font inside the stylesheet). 456 checks in all.

**Checklist**
- [ ] On a laptop, the Editor opens documents in Monaco; on a phone, in CodeMirror.
- [ ] A laptop in Monaco and a phone in CodeMirror type in one document at once: the text stays the same on both, and each sees the other's cursor and name.
- [ ] Ctrl+Z in Monaco takes back only your own typing, not what the phone typed.
- [ ] Settings → Editor → CodeMirror, then back to Monaco: the open document stays open, where the cursor was.
- [ ] Monaco in the dark theme, and in a narrow side panel: the find widget and suggestions aren't cut off.
- [ ] Choose Monaco on a phone: it works, if less comfortably.

## Backlog (to triage)

Ideas raised on 2026-09-23 and not yet scheduled into a slice. Size is a rough guess: **S** about half a day, **M** a day or two, **L** a slice of its own.

### Tools people would use
- **Push to talk** (S) — hold a button (or Space on a laptop) to unmute, for a noisy room or a phone in a café. Slice 8 ships the open mic with mute.
- **Clipboard sync** (S) — copy on the laptop, paste on the phone. A tiny tool over ctl, or part of Chat.
- **Phone as a webcam or document scanner** (M) — the phone's camera as a panel on the laptop, with a "take a photo into the room" button.
- **Watch together** (M) — shared play, pause and seek for a file kept in the room (needs Slice 9's kept files).
- **Small room tools** (S each) — a poll, a shared timer, dice. Good practice for the tool API before the game slices.

### Robustness of the room
- **Fallback anchor IDs** (M) — derive `anchor2` and `anchor3` from the code. Today a crashed anchor holds the room's address for about 100 s and newcomers wait; with fallbacks they get in at once.
- **Self-hosted signaling** (S) — a `peerjs-server` guide beside `docs/turn-server.md`, on the VPS that already runs coturn. Removes the "public 0.peerjs.com is unreliable" risk.
- **Offline, the rest of it** (S) — the service worker of 2026-09-23 already opens the app with no internet, but `vendor/editor.js` is cached only after the Editor tab has been opened once, and a device with no network has no signaling server to talk to. Pairs with a signaling server on the same LAN.
- **Update notice** (S) — the app checks its deployed version and offers "PeerKit was updated — reload", so a protocol mismatch explains itself instead of a bare "version" rejection. The service worker knows when a new version has been fetched, so it can say so.
- **Room export and import** (M) — save a room's documents and chat to a file and read it back; plus what each room uses on this device, in Settings.

### Project health
- **Browser test harness** (M) — `test/room.html` opens several iframes of the app, drives them through a scripted room (join, send a file, type, kill the anchor) and shows pass/fail. Runs on the phone too, so the Android items on the checklists stop being hand work.
- **CI** (S) — GitHub Actions running `node test/run.mjs` and the syntax check on every push.
- **In-app log panel** (M) — errors and the last protocol messages, copyable. On a phone there is no console, so today a failure during testing leaves nothing to look at. Would also cover the "connection diagnostics" idea: ICE candidate types and a bitrate graph beyond the Direct/Relayed label.
- **Security review pass** (M) — the handshake and everything read from links, storage and members, written down as a short threat model.
- **Accessibility and keyboard pass** (M) — focus order and traps in the dialogs, labels, visible focus, reduced motion.

### Reach
- **Russian UI** (M) — needs a string table first; the strings are spread through the views today.

## Later ideas (not scheduled)
- Video forwarding by viewers: a viewer re-sends a stream it receives when the sender's upload isn't enough. It re-encodes, which adds delay and loses some quality, and a leaving viewer cuts off everyone after it.
- Several open rooms per device, and moving a room to another signaling server.
- iOS Safari: DeviceOrientation permission prompt, autoplay rules, download quirks.

## Risks to keep in mind
- **Rooms without a host** depend on the anchor handover (Slice 7 spike): an anchor that drops off the network may hold the room's peer ID for up to the server's alive timeout, and newcomers wait that long.
- **Upload in rooms:** the sender of a stream sends one copy per viewer. With about 6 members that's fine on home internet and heavy on mobile data.
- **No removal:** anyone who ever had a room code can rejoin and read the room's documents, chat and kept files. Creating a new room is the only way to exclude someone.
- **Public 0.peerjs.com** is shared and sometimes unreliable. The Slice 2 "Test connection" button and readable errors help tell a broker problem from an app bug.
- **Android Chrome in the background** suspends timers and may drop WebRTC. Wake Lock and reconnect cover most of this, but a locked phone isn't a supported state for streaming.
- **peerjs upgrade** from the old vendored build to 1.5+: serialization defaults changed. File transfer should rely only on the `raw` channel with manual chunking so it doesn't depend on library internals.
- **TURN secret on devices:** it lives in localStorage and in the Settings export. Anyone who has it can use the relay; changing the secret on the server revokes everything issued.
- **Relayed traffic** uses the VPS's bandwidth: about 1 GB per hour of 720p video.
- **FCEUX licence:** FCEUX is GPL-2.0, so publishing the wasm on GitHub Pages needs a pointer to its source. Before vendoring, check that the public fork (github.com/ryanwmoore/fceux) has this build's exports (`setGamePadValue`, `enableFourScore`, `saveState`, `loadState`); if not, rebuild from source. `nesparty.js` is Kosmi's own code: read it, don't copy it.
- **Editor bundle size** (roughly 0.5–1 MB): loaded only when the Editor tab is first opened.
