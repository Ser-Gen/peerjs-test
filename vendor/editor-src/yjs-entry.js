// The shared-data half of PeerKit's bundles, as one ES module: vendor/yjs.js.
// The chat's room document needs only this, so it doesn't load CodeMirror. vendor/editor.js imports this file
// instead of carrying a copy of its own: two copies of yjs in one page break it.

// Yjs itself at the top level too: that is how the editor bundle's own `import * as Y from 'yjs'` finds it.
export * from 'yjs';
export * as Y from 'yjs';
export * as syncProtocol from 'y-protocols/sync';
export * as awarenessProtocol from 'y-protocols/awareness';
export * as encoding from 'lib0/encoding';
export * as decoding from 'lib0/decoding';
export { IndexeddbPersistence } from 'y-indexeddb';
