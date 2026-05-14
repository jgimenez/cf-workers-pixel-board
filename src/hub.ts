import { DurableObject } from "cloudflare:workers";
import {
  BOARD_SIZE,
  TILE_COUNT,
  TILE_SIZE,
  TILES_PER_ROW,
  MSG_INIT,
  MSG_PIXEL,
} from "./protocol";

export interface HubEnv {
  TILE: DurableObjectNamespace<import("./tile").Tile>;
}

export class BoardHub extends DurableObject<HubEnv> {
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    // Push initial snapshot
    const board = await this.aggregateBoard();
    const init = new Uint8Array(1 + board.length);
    init[0] = MSG_INIT;
    init.set(board, 1);
    try {
      server.send(init);
    } catch {
      // socket may have closed already
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async broadcast(x: number, y: number, color: number): Promise<void> {
    const buf = new Uint8Array(4);
    buf[0] = MSG_PIXEL;
    buf[1] = x & 0xff;
    buf[2] = y & 0xff;
    buf[3] = color & 0x0f;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(buf);
      } catch {
        // best-effort
      }
    }
  }

  async broadcastClear(): Promise<void> {
    const blank = new Uint8Array(1 + BOARD_SIZE * BOARD_SIZE);
    blank[0] = MSG_INIT; // all remaining bytes are 0 = white
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(blank); } catch {}
    }
  }

  async webSocketMessage(): Promise<void> {
    // Clients are read-only. Ignore.
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try { ws.close(1000); } catch {}
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try { ws.close(1011); } catch {}
  }

  private async aggregateBoard(): Promise<Uint8Array> {
    const tiles = await Promise.all(
      Array.from({ length: TILE_COUNT }, (_, i) =>
        this.env.TILE.get(this.env.TILE.idFromName(`tile-${i}`)).getState()
      )
    );
    const board = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
    for (let i = 0; i < TILE_COUNT; i++) {
      const tileRow = (i / TILES_PER_ROW) | 0;
      const tileCol = i % TILES_PER_ROW;
      const data = tiles[i];
      for (let py = 0; py < TILE_SIZE; py++) {
        const gy = tileRow * TILE_SIZE + py;
        const dstRowStart = gy * BOARD_SIZE + tileCol * TILE_SIZE;
        const srcRowStart = py * TILE_SIZE;
        board.set(data.subarray(srcRowStart, srcRowStart + TILE_SIZE), dstRowStart);
      }
    }
    return board;
  }
}
