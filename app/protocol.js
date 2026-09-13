// Bump when messages change incompatibly; peers with different versions refuse to pair.
export const PROTOCOL_VERSION = 1;

// Message channels on the control connection. Every message is `{ ch, type, ...payload }`.
export const CH = {
	SYS: 'sys', // hello / welcome / reject / ping / pong
	TRANSFER: 'transfer', // text + file offers
};

// peerjs DataConnection labels.
export const LABEL = {
	CTL: 'ctl', // JSON, reliable: all control messages
	FILE: 'file', // raw binary, reliable: file chunks framed as [u32 transfer id][bytes]
};
