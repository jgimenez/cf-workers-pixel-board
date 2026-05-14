// Pure JS PNG encoder. RGBA8 only. No dependencies.
// Uses CompressionStream("deflate") which is built into Workers runtime
// and emits a zlib-wrapped stream (what PNG IDAT expects).

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeU32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  if (typeBytes.length !== 4) throw new Error("PNG chunk type must be 4 chars");
  const out = new Uint8Array(4 + 4 + data.length + 4);
  writeU32BE(out, 0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crcBuf = new Uint8Array(4 + data.length);
  crcBuf.set(typeBytes, 0);
  crcBuf.set(data, 4);
  writeU32BE(out, 8 + data.length, crc32(crcBuf));
  return out;
}

async function deflate(input: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  void writer.write(input);
  void writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

export async function encodePNG(
  rgba: Uint8Array,
  width: number,
  height: number
): Promise<Uint8Array> {
  if (rgba.length !== width * height * 4) {
    throw new Error("RGBA buffer length mismatch");
  }
  // Build raw scanlines with filter byte 0 (None) per row.
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const compressed = await deflate(raw);

  // Build PNG
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  writeU32BE(ihdr, 0, width);
  writeU32BE(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const ihdrChunk = chunk("IHDR", ihdr);
  const idatChunk = chunk("IDAT", compressed);
  const iendChunk = chunk("IEND", new Uint8Array(0));

  const out = new Uint8Array(
    signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length
  );
  let off = 0;
  out.set(signature, off); off += signature.length;
  out.set(ihdrChunk, off); off += ihdrChunk.length;
  out.set(idatChunk, off); off += idatChunk.length;
  out.set(iendChunk, off);
  return out;
}

// Convert a 64×64 palette-index board (1 byte per pixel, 0-15) into RGBA
// upscaled 8× (512×512) via nearest neighbor. Larger images give vision
// models more to work with.
export async function boardToPNG(
  board: Uint8Array,
  paletteRgba: ReadonlyArray<[number, number, number, number]>
): Promise<Uint8Array> {
  const SRC = 64;
  const SCALE = 8;
  const DST = SRC * SCALE; // 512
  if (board.length !== SRC * SRC) {
    throw new Error("Expected 4096-byte board");
  }
  const rgba = new Uint8Array(DST * DST * 4);
  for (let y = 0; y < DST; y++) {
    const sy = (y / SCALE) | 0;
    for (let x = 0; x < DST; x++) {
      const sx = (x / SCALE) | 0;
      const idx = board[sy * SRC + sx] & 0x0f;
      const [r, g, b, a] = paletteRgba[idx];
      const off = (y * DST + x) * 4;
      rgba[off] = r;
      rgba[off + 1] = g;
      rgba[off + 2] = b;
      rgba[off + 3] = a;
    }
  }
  return encodePNG(rgba, DST, DST);
}
