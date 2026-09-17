// Bump when messages change incompatibly; members with different versions refuse to link.
export const PROTOCOL_VERSION = 4;

// Message channels on the control connection. Every message is `{ ch, type, ...payload }`.
export const CH = {
	SYS: 'sys', // links, room membership, ping / pong
	TRANSFER: 'transfer', // text + file offers
	STREAM: 'stream', // camera / screen start, stop, close (media itself goes over a peerjs call)
	DOC: 'doc', // shared editor: Yjs sync and awareness (app/tools/editor/provider.js)
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

// peerjs DataConnection labels.
export const LABEL = {
	CTL: 'ctl', // JSON, reliable: all control messages
	FILE: 'file', // raw binary, reliable: file chunks framed as [u32 transfer id][bytes]
	ENTRY: 'entry', // JSON, reliable: a newcomer's handshake with the anchor
};
