import { DurableObject } from "cloudflare:workers";
import { TILE_SIZE } from "./protocol";

// One Tile DO owns a 16×16 region. State is stored as a 256-byte Uint8Array
// where each byte is a palette index 0-15. Storage key: "data".

export interface TileEnv {}

export class Tile extends DurableObject<TileEnv> {
  async setPixel(localX: number, localY: number, color: number): Promise<void> {
    if (
      localX < 0 || localX >= TILE_SIZE ||
      localY < 0 || localY >= TILE_SIZE
    ) {
      throw new Error(`Invalid local coords (${localX}, ${localY})`);
    }
    const data =
      (await this.ctx.storage.get<Uint8Array>("data")) ??
      new Uint8Array(TILE_SIZE * TILE_SIZE);
    data[localY * TILE_SIZE + localX] = color & 0x0f;
    await this.ctx.storage.put("data", data);
  }

  async getState(): Promise<Uint8Array> {
    return (
      (await this.ctx.storage.get<Uint8Array>("data")) ??
      new Uint8Array(TILE_SIZE * TILE_SIZE)
    );
  }

  async reset(): Promise<void> {
    await this.ctx.storage.delete("data");
  }
}
