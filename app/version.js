// The app version. The minor number is the last finished slice in PLAN.md, so 0.8.0 lands with Slice 8.
// Bump it when a slice is finished, the patch number for work between slices; PROTOCOL_VERSION in
// protocol.js changes only when messages change. sw.js caches under this number, so it must match.
export const APP_VERSION = '0.10.0';
