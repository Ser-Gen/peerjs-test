// Bump when messages change incompatibly; members with different versions refuse to link.
export const PROTOCOL_VERSION = 6;

// Message channels on the control connection. Every message is `{ ch, type, ...payload }`.
export const CH = {
	SYS: 'sys', // links, room membership, ping / pong
	TRANSFER: 'transfer', // file offers and requests for kept files (app/tools/chat/transfers.js)
	STREAM: 'stream', // camera / screen start, stop, close (media itself goes over a peerjs call)
	VOICE: 'voice', // who is in the room's voice conversation (app/voice.js)
	DOC: 'doc', // shared editor: Yjs sync and awareness (app/docsync.js)
	ROOM: 'room', // the room document: the chat and its file list, Yjs sync like DOC (app/roomdoc.js)
	BOARD: 'board', // the whiteboard's boards, Yjs sync and awareness like DOC (app/tools/whiteboard/)
};

/*
 * Links (ch: 'sys'). Every pair of members has one link: a ctl and a file connection, dialed by one side.
 * A newcomer first opens an entry connection (label 'entry') to the room's anchor peer ID; the same
 * handshake runs there, then the anchor sends the member list and the newcomer dials every member.
 *
 * Handshake: proofs are HMACs with the room key (app/rooms.js) over the role, both nonces, both peer IDs
 * and both DTLS fingerprints, so only devices that know the code get in, and a relay in the middle can't.
 *   hello   {v, nonce, name, deviceId}           dialer → answerer
 *   hello   {v, nonce, name, deviceId, proof}    answerer → dialer
 *   proof   {proof}                              dialer → answerer; the link is authenticated
 *   reject  {reason}                             version | denied | duplicate | full
 * On an entry connection:
 *   welcome {members: [{peerId, name, deviceId}], turn?}   anchor → newcomer, then the entry connection closes
 * On a link:
 *   anchor  {held}      the sender holds the anchor peer ID (or stopped holding it)
 *   links   {peers}     the sender's direct links, so documents can be forwarded to members not linked to it
 *   name    {name}      the sender's device name changed
 *   turn    {turn}      temporary TURN credentials {host, port, tlsPort, username, credential}
 *   ping / pong {t}
 *   bye     {}          the sender leaves the room on purpose
 */

/*
 * Media calls carry `metadata.kind`: 'camera' and 'screen' belong to the Stream tool, 'voice' to app/voice.js.
 * A call of an unknown kind is refused. This is why version 4 and version 5 refuse to link: a version-4
 * device answers every call as a stream and would put a voice call on its video stage.
 *
 * Voice (ch: 'voice'):
 *   state {on, muted, mic}   the sender's voice state; sent on every link up and whenever it changes
 *
 * Version 6 moved the chat into the room document (ch: 'room'): a version-5 device sends text as
 * `transfer` messages that a version-6 device no longer reads, so the two refuse to link.
 * The whiteboard's channel ('board') came later without a new version: a device that has no whiteboard yet
 * ignores the channel, and syncs the boards once it has one.
 */

// peerjs DataConnection labels.
export const LABEL = {
	CTL: 'ctl', // JSON, reliable: all control messages
	FILE: 'file', // raw binary, reliable: file chunks framed as [u32 transfer id][bytes]
	ENTRY: 'entry', // JSON, reliable: a newcomer's handshake with the anchor
};
