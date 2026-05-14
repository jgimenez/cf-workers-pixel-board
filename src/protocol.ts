// WebSocket binary protocol.
// All messages from server to client. Client only opens the socket and listens.
//
// Message types (first byte):
//   0x00 — INIT snapshot: [0x00, ...4096 bytes (1 byte per pixel, 0-15)]
//   0x01 — PIXEL update:  [0x01, x, y, color]
//
// Board layout: 64×64 row-major. byte index = y * 64 + x.

export const MSG_INIT = 0x00;
export const MSG_PIXEL = 0x01;
export const BOARD_SIZE = 64;
export const TILE_SIZE = 16;
export const TILES_PER_ROW = BOARD_SIZE / TILE_SIZE;
export const TILE_COUNT = TILES_PER_ROW * TILES_PER_ROW;
