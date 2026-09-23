# PeerKit

Peer-to-peer tools in a browser room, built on [PeerJS](https://peerjs.com/) (WebRTC). Open the site, make a room, and share its link, QR code or 4-word code. Up to 8 devices join, and everything travels directly between them: the server only introduces the devices to each other.

Tools in a room:

* **Transfer** — text to everyone, and files to each member, with progress.
* **Stream** — camera or screen, to one member for now.
* **Editor** — documents written together, with cursors, kept in the browser and synced across the room.
* **Voice** — talk to everyone in the room, with mute and who-is-speaking, from the bar above the tools.

A room keeps working when anyone leaves, including whoever made it: one device holds the room's address on the signaling server, and another takes over when it goes.

## Installing it

PeerKit is a progressive web app: Chrome's **Install app** (or Settings → Install inside PeerKit) puts it on the home screen, where it opens without the browser chrome and keeps opening with no internet. An installed copy also appears in Android's share sheet, so **Share → PeerKit** sends a photo, a file or a link straight into the open room. Installing needs the HTTPS address.

## Running it

Static files, no build step:

```sh
python3 -m http.server   # then open http://localhost:8000
```

Phone features (camera, clipboard, wake lock, room locks) need HTTPS, so test on a phone through GitHub Pages rather than a LAN address.

Tests run in Node:

```sh
node test/run.mjs        # see test/README.md
```

## More

* [PLAN.md](PLAN.md) — the roadmap, slice by slice, and the backlog.
* [test/README.md](test/README.md) — what the tests cover and how to add one.
* [docs/turn-server.md](docs/turn-server.md) — running a TURN relay for networks that block direct connections.
* [vendor/README.md](vendor/README.md) — the vendored libraries and how the editor bundle is built.

## Old demos

The standalone demos this app grew from, each with its own old copy of PeerJS:

* [gamepad](demos/gamepad)
* [gyro](demos/gyro)
* [screen](demos/screen)
* [share](demos/share)
* [webcam](demos/webcam)
* [recorder](demos/recorder)
* [ping](demos/ping)

## Licence

[MIT](LICENSE). The vendored libraries keep their own licences, listed in [vendor/README.md](vendor/README.md).
