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
| Files | Chunked with progress, up to about 2 GB in memory. On Chrome, an option saves the file straight to disk so size is unlimited. |
| Recorder | Records an incoming stream on the receiving side. |
| Gyro / gamepad | Become the controller input layer for future party games (NES pad, Wii-tennis / Beat Saber style swing). |
| Browsers | Android Chrome and desktop browsers. iOS Safari is out of scope, but nothing should rule it out. |
| UI | English. The old demos move to `/demos` and stay as reference. |

## Target structure

```
index.html              app shell (mobile-first)
app/
  main.js               boot, hash routing, role detection (host / guest)
  settings.js           server profiles: CRUD, localStorage, encode/decode for links
  session.js            Peer lifecycle, stable id, reconnect, connections, event bus
  protocol.js           message envelope {ch, type, slot, ...} + version
  ui/                   qr, toast, sheet/dialog, status bar, styles.css
  tools/                one module per tool, same interface
    transfer.js         text + files
    stream.js           camera / screen
    recorder.js         record incoming stream
    controller.js       phone-as-gamepad + gyro
    monitor.js          host-side input visualizer
  games/                (later) game modules consuming controller input
vendor/peerjs.min.js    upgraded to latest 1.x UMD
vendor/qrcode.js
demos/                  old demos, untouched, with their original peerjs/qrcode builds
```

**Tool interface:** `{ id, title, supported(), mount(el, session) → unmount }`.
- A tool subscribes to its own channel on the session bus.
- `supported()` hides tools the device can't run. For example, screen share is hidden on Android.

**Link format:** `https://<pages>/#join=<roomId>&s=<base64url(profile)>`
- The fragment never reaches the web server.
- `s` is left out for the default profile, which keeps the QR small.

**Profile shape:** `{ name, host, port, path, key, secure, iceServers? }`
- `iceServers` is optional and has no UI for now. It leaves room for TURN later without changing the link format.

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
- [ ] Send a ~500 MB video laptop → phone; progress is smooth, the page stays responsive, and the phone screen doesn't sleep.
- [ ] Cancel mid-transfer on either side stops both sides cleanly.
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

**Tricky points**
- After a reload, the broker keeps the old ID reserved for roughly the alive timeout (60 s by default on peerjs-server). Expect `unavailable-id` on a fast reload and retry quietly for a while before showing an error.
- Short codes can be guessed. The approval prompt for unknown guests is the only access control, so keep it on by default for typed-code joins.
- A typed code only works if both devices are on the same server. Say so in the UI.

**Checklist**
- [ ] Reload the laptop (host): within ~1 min the phone reconnects by itself without re-scanning.
- [ ] Lock the phone for 30 s, unlock: connection comes back and status shows it.
- [ ] Turn phone Wi-Fi off/on: "Reconnecting…" then "Connected".
- [ ] Yesterday's QR (same laptop, same profile) still connects.
- [ ] Type the room code on the phone's Join screen: connects.
- [ ] A second, never-seen device joining by code triggers an allow/deny prompt on the host.
- [ ] Phone's Recent hosts shows the laptop; one tap reconnects after closing the browser.
- [ ] Opening the host in a second tab shows the "open in another tab" message.
- [ ] Regenerate code: old QR stops working, new one works.

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

**Checklist**
- [ ] Phone → laptop: back camera appears on laptop; switch to front camera without the stream restarting.
- [ ] Laptop receives muted; "Tap for sound" enables audio.
- [ ] Laptop → phone: screen share shows on phone, fullscreen works in landscape.
- [ ] "Screen" source is not offered on the phone.
- [ ] Stop on the sender makes the receiver show "Stream ended"; starting again works without reload.
- [ ] Send a file while a camera stream is running — both work.
- [ ] Reload during a stream: session reconnects (Slice 3) and the stream can be restarted with one tap.

### Slice 5 — Record incoming stream

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

### Slice 6 — Unlimited-size files on Chrome

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

### Slice 8 — Party mode: 1 host + N controllers

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

**Checklist**
- [ ] Two phones join the laptop by room code; lobby shows two coloured slots with nicknames.
- [ ] Both controllers show separately on the monitor.
- [ ] Reload one phone: it returns to the same slot/colour.
- [ ] Kick a player: their phone shows "Removed from room" and can't rejoin while locked.
- [ ] Sending a file in party mode asks which device to send to.
- [ ] Normal 1-to-1 mode (Slices 1–7) still behaves as before.

### Slice 9 — Game module API and first games

**Why:** proves the input layer is good enough for real games, and gives new games a template to follow.

**Build**
- `games/<id>/game.js` interface: `{ id, title, players:{min,max}, controllerLayout, mount(el, input), unmount() }`. The host lists games in a Games tab, and the phones switch to the declared layout automatically.
- **Swing test** (Wii-tennis-like): swing speed and direction from the quaternion's angular velocity, shown as a meter per player. This is used to tune the gyro pipeline.
- **NES**: vendor an emulator (e.g. jsnes). The host loads a ROM from a local file (no ROMs are shipped), and slots 1–2 map to NES pads. Audio plays on the host.

**Checklist**
- [ ] Games tab lists "Swing test" and "NES"; starting one switches phones to the correct layout.
- [ ] Swing test: a hard swing and a soft swing give clearly different readings; left/right direction is correct.
- [ ] NES: load a legally obtained ROM; two phones control players 1 and 2 with no noticeable lag.
- [ ] Leaving a game returns phones to the normal controller.

---

## Later ideas (not scheduled)
- TURN support in the profile UI (the `iceServers` field already exists) for mobile networks where direct P2P fails.
- Connection diagnostics tool: ICE candidate types, whether the route is relayed or direct, bitrate graph.
- PWA manifest and share target, so "Share → PeerKit" from the Android gallery sends a file directly.
- Clipboard sync (desktop paste goes straight to the phone).
- iOS Safari: DeviceOrientation permission prompt, autoplay rules, download quirks.

## Risks to keep in mind
- **Public 0.peerjs.com** is shared and sometimes unreliable. The Slice 2 "Test connection" button and readable errors help tell a broker problem from an app bug.
- **Android Chrome in the background** suspends timers and may drop WebRTC. Wake Lock and reconnect cover most of this, but a locked phone isn't a supported state for streaming.
- **peerjs upgrade** from the old vendored build to 1.5+: serialization defaults changed. File transfer should rely only on the `raw` channel with manual chunking so it doesn't depend on library internals.
