# PeerKit — plan for merging the peerjs demos into one tool

A single mobile-first static web app. Two devices pair once (QR, link or short code) and then use every tool over that one session. These tools grow out of the existing demos: ping, share, screen, webcam, recorder, gyro and gamepad.

## Decisions (from the interview)

| Topic | Decision |
|---|---|
| Stack | Static files with no build step: `index.html` plus native ES modules. Libraries are vendored in `vendor/`. Hosted on GitHub Pages. |
| Session | Pair once, then use all tools. Either side can open any tool. |
| Peers | 1-to-1 for now. The protocol carries player slots from day one, and a later slice adds 1 host + N controllers. |
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

## Target structure

```
index.html              app shell (mobile-first)
app/
  main.js               boot, hash routing, role detection (host / guest)
  settings.js           server profiles: CRUD, localStorage, encode/decode for links
  rooms.js              room codes, trusted guests, recent hosts
  device.js             device ID and name
  turn.js               TURN credentials (HMAC-SHA1), relay test, Direct/Relayed detection
  session.js            Peer lifecycle, stable id, reconnect, connections, event bus
  protocol.js           message envelope {ch, type, slot, ...} + version
  ui/                   qr, toast, sheet/dialog, status bar, styles.css
  tools/                one module per tool, same interface
    transfer.js         text + files
    stream.js           camera / screen
    editor/             shared editor: tool UI + Yjs provider over the session
    controller.js       phone-as-gamepad + gyro
    monitor.js          host-side input visualizer
    nes/                NES tool + frame.html that hosts the emulator
  games/                (later) game modules consuming controller input
vendor/peerjs.min.js    peerjs 1.5.5 UMD
vendor/qrcode.js
vendor/editor.js        CodeMirror 6 + Yjs bundle, built once from pinned npm versions (recipe in vendor/README.md)
vendor/fceux/           FCEUX Emscripten build (js + wasm), GPL-2.0, with a source link
docs/turn-server.md     coturn setup guide
demos/                  old demos, untouched, with their original peerjs/qrcode builds
```

**Tool interface:** `{ id, title, supported(), mount(el, session, ctx) → unmount }`, where `ctx = { activate(), notify() }`.
- A tool subscribes to its own channel on the session bus.
- `supported()` hides tools the device can't run. For example, screen share is hidden on Android.

**Link format:** `https://<pages>/#join=<room code>&t=<token>&s=<base64url(profile)>&r=<base64url(TURN credentials)>`
- The fragment never reaches the web server.
- `s` is left out for the default profile, which keeps the QR small.
- `t` is the host's secret: a guest that has it connects without an approval prompt. A typed code has no `t`.
- `r` carries temporary TURN credentials from the host (Slice 5), never the TURN secret.

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

**Checklist**
- [ ] Typing on the laptop appears on the phone as you type; both cursors are visible with device names.
- [ ] Both devices type in the same line at once: no lost characters, and both end with the same text.
- [ ] Phone in airplane mode, edit on both, reconnect: the edits merge on both.
- [ ] Reload either device: the documents are still there and in sync.
- [ ] Laptop shortcuts: Ctrl/Cmd+D, Alt+↑/↓, Ctrl/Cmd+/, Ctrl/Cmd+F, multiple cursors.
- [ ] Android Chrome with Gboard: autocorrect, swipe typing and selection handles work; the toolbar stays above the keyboard.
- [ ] Paste 1 MB of text: it syncs without freezing the session or breaking Transfer.
- [ ] Open a local `.md` file, edit it together, download it.

### Slice 7 — Phone as controller

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

**Checklist**
- [ ] Phone NES layout in landscape: pressing D-pad/A/B lights them instantly on the laptop monitor.
- [ ] Pressing two buttons with two thumbs registers both.
- [ ] Rotate the phone: the monitor's orientation cube follows smoothly; Recenter resets it.
- [ ] Latency figure on the monitor stays low (~tens of ms on the same Wi-Fi).
- [ ] Screen doesn't sleep while the controller is open; vibration on press works.
- [ ] A USB/Bluetooth gamepad connected to the phone shows on the laptop monitor.
- [ ] Rapid tap of a button is never missed, even under packet loss.

### Slice 8 — NES (two players)

**Why:** the first real game on the input layer. A laptop or TV runs the emulator; a phone is the second pad, either on the couch or remotely with the picture streamed to it.

**Build**
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
  - **Controller only**: the Slice 7 NES layout, for playing in front of the host's screen.
  - **Remote play**: the host streams the canvas and sound (media call kind `nes`, music audio from Slice 4) with the touch pad over it.
- Input: the Slice 7 input channel; the host maps each slot to a pad and calls `_setGamePadValue`.
- When the guest drops, the game pauses; it continues on reconnect.

**Checklist**
- [ ] Load a legally obtained ROM on the laptop: picture and sound at the right speed on a 60 Hz and on a 120 Hz+ screen.
- [ ] Phone in Controller only: player 2 responds with no noticeable lag; the laptop keyboard controls player 1.
- [ ] Phone in Remote play: sees the game with sound and plays player 2.
- [ ] Save state, keep playing, load state: back to the saved moment, also after a reload.
- [ ] Stop the game or leave the tab: the emulator unloads (no sound, CPU drops).
- [ ] A USB/Bluetooth gamepad on the laptop plays player 1.

### Slice 9 — Party mode: 1 host + N controllers

**Why:** several phones can join one screen, which is the prerequisite for multiplayer games.

**Build**
- A host "Party" mode that accepts many guests.
  - `session.js` moves from a single connection to a `peers` map. Every message already carries `slot`.
- Lobby screen on the host:
  - The room code in large type plus a QR.
  - Player slots with a colour and a nickname chosen on the phone.
  - Actions: kick, reorder slots, lock room.
- Tools declare a `scope`:
  - `per-peer` tools (Transfer, Stream) ask which peer to target.
  - `broadcast` tools (Controller input) take input from all slots.
- Reconnect keeps a player's slot, using the guest ID from Slice 3.
- The Monitor tool shows every slot at once.
- NES: Four Score on; slots 1–4 map to pads 1–4, and any player can watch the stream.
- The editor provider syncs with every peer, and each peer's cursor gets its slot colour.

**Checklist**
- [ ] Two phones join the laptop by room code; lobby shows two coloured slots with nicknames.
- [ ] Both controllers show separately on the monitor.
- [ ] Reload one phone: it returns to the same slot/colour.
- [ ] Kick a player: their phone shows "Removed from room" and can't rejoin while locked.
- [ ] Sending a file in party mode asks which device to send to.
- [ ] Four phones play a 4-player NES game (Four Score), each with its own pad.
- [ ] Three devices edit one document together.
- [ ] Normal 1-to-1 mode (Slices 1–8) still behaves as before.

### Slice 10 — Game module API and more games

**Why:** gives new games a template, and proves the input layer is good enough for motion games too.

**Build**
- `games/<id>/game.js` interface: `{ id, title, players:{min,max}, controllerLayout, mount(el, input), unmount() }`. The host lists games in a Games tab, and the phones switch to the declared layout automatically.
- The NES tool from Slice 8 moves behind this interface.
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

## Later ideas (not scheduled)
- Connection diagnostics tool beyond the Direct/Relayed label: ICE candidate types, bitrate graph.
- PWA manifest and share target, so "Share → PeerKit" from the Android gallery sends a file directly.
- Clipboard sync (desktop paste goes straight to the phone).
- iOS Safari: DeviceOrientation permission prompt, autoplay rules, download quirks.

## Risks to keep in mind
- **Public 0.peerjs.com** is shared and sometimes unreliable. The Slice 2 "Test connection" button and readable errors help tell a broker problem from an app bug.
- **Android Chrome in the background** suspends timers and may drop WebRTC. Wake Lock and reconnect cover most of this, but a locked phone isn't a supported state for streaming.
- **peerjs upgrade** from the old vendored build to 1.5+: serialization defaults changed. File transfer should rely only on the `raw` channel with manual chunking so it doesn't depend on library internals.
- **TURN secret on devices:** it lives in localStorage and in the Settings export. Anyone who has it can use the relay; changing the secret on the server revokes everything issued.
- **Relayed traffic** uses the VPS's bandwidth: about 1 GB per hour of 720p video.
- **FCEUX licence:** FCEUX is GPL-2.0, so publishing the wasm on GitHub Pages needs a pointer to its source. Before vendoring, check that the public fork (github.com/ryanwmoore/fceux) has this build's exports (`setGamePadValue`, `enableFourScore`, `saveState`, `loadState`); if not, rebuild from source. `nesparty.js` is Kosmi's own code: read it, don't copy it.
- **Editor bundle size** (roughly 0.5–1 MB): loaded only when the Editor tab is first opened.
