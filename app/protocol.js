// Bump when messages change incompatibly; peers with different versions refuse to pair.
export const PROTOCOL_VERSION = 3;

// Message channels on the control connection. Every message is `{ ch, type, ...payload }`.
export const CH = {
	SYS: 'sys', // pairing, ping / pong
	TRANSFER: 'transfer', // text + file offers
	STREAM: 'stream', // camera / screen start, stop, close (media itself goes over a peerjs call)
	DOC: 'doc', // shared editor: Yjs sync and awareness (app/tools/editor/provider.js)
};

/*
 * Pairing (ch: 'sys'):
 *   hello   {v, name, deviceId, token?, auto}  guest → host; auto = an automatic reconnect attempt
 *   pending {}                                 host → guest; the host screen asks whether to let it in
 *   welcome {v, name, deviceId, token, turn?}  host → guest; the token lets it back in without asking,
 *                                              turn = temporary TURN credentials {host, port, tlsPort, username, credential}
 *   reject  {reason}                           host → guest; busy | version | denied | no-answer | ended
 *   bye     {}                                 either side ends the session on purpose
 */

// The secret in a QR code or link that lets a guest in without the host confirming it.
export const TOKEN_RE = /^[0-9a-f]{12}$/;

// peerjs DataConnection labels.
export const LABEL = {
	CTL: 'ctl', // JSON, reliable: all control messages
	FILE: 'file', // raw binary, reliable: file chunks framed as [u32 transfer id][bytes]
};
