import {
  validateTurnstile,
  issueSessionCookie,
  verifySessionFromRequest,
} from "./auth";
import { PALETTE, hexToRgba, isValidColorIndex } from "./palette";
import { BOARD_SIZE, TILE_SIZE, TILES_PER_ROW } from "./protocol";
import { boardToPNG } from "./png";
import { Tile } from "./tile";
import { BoardHub } from "./hub";

export { Tile, BoardHub };

export interface Env {
  ASSETS: Fetcher;
  AI: Ai;
  TILE: DurableObjectNamespace<Tile>;
  BOARD_HUB: DurableObjectNamespace<BoardHub>;
  TURNSTILE_SECRET: string;
  TURNSTILE_SITE_KEY: string;
  SESSION_HMAC_SECRET: string;
  CF_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  // Optional fallback if not using WAF Rate Limiting
  // PAINT_LIMITER?: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
}

// Verify a Cloudflare Access JWT (RS256). Returns false on any failure.
// If teamDomain or aud are empty, skips validation (local dev).
async function verifyAccessJwt(jwt: string, teamDomain: string, aud: string): Promise<boolean> {
  if (!teamDomain || !aud) return true; // local dev bypass
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  try {
    const b64 = (s: string) => s.replace(/-/g, "+").replace(/_/g, "/");
    const header = JSON.parse(atob(b64(parts[0])));
    const payload = JSON.parse(atob(b64(parts[1])));
    if (payload.exp < Math.floor(Date.now() / 1000)) return false;
    const audOk = Array.isArray(payload.aud) ? payload.aud.includes(aud) : payload.aud === aud;
    if (!audOk) return false;
    const jwksRes = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
    if (!jwksRes.ok) return false;
    const { keys } = await jwksRes.json() as { keys: JsonWebKey[] };
    const jwk = (keys as any[]).find((k) => k.kid === header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
    );
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig = Uint8Array.from(atob(b64(parts[2])), (c) => c.charCodeAt(0));
    return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data);
  } catch {
    return false;
  }
}

const PALETTE_RGBA = PALETTE.map((h) => hexToRgba(h));

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

function clientIP(req: Request): string {
  return req.headers.get("CF-Connecting-IP") ?? "";
}

function getHub(env: Env): DurableObjectStub<BoardHub> {
  return env.BOARD_HUB.get(env.BOARD_HUB.idFromName("hub"));
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // -------- Admin page --------
    if (url.pathname === "/admin.html") {
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname === "/admin" && req.method === "GET") {
      const jwt = req.headers.get("CF-Access-Jwt-Assertion") ?? "";
      const ok = await verifyAccessJwt(jwt, env.CF_TEAM_DOMAIN, env.CF_ACCESS_AUD);
      if (!ok) return new Response("Unauthorized", { status: 401 });
      return env.ASSETS.fetch(new Request(new URL("/admin.html", req.url).toString()));
    }

    // -------- API routes --------
    if (url.pathname === "/api/whoami" && req.method === "GET") {
      const sid = await verifySessionFromRequest(req, env.SESSION_HMAC_SECRET);
      return json({
        authenticated: sid !== null,
        siteKey: env.TURNSTILE_SITE_KEY,
        palette: PALETTE,
      });
    }

    if (url.pathname === "/api/session" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { token?: string };
      if (!body.token) return json({ error: "missing token" }, { status: 400 });
      const ok = await validateTurnstile(
        body.token,
        clientIP(req),
        env.TURNSTILE_SECRET
      );
      if (!ok) return json({ error: "turnstile failed" }, { status: 403 });
      const cookie = await issueSessionCookie(env.SESSION_HMAC_SECRET);
      return json({ ok: true }, { headers: { "Set-Cookie": cookie } });
    }

    if (url.pathname === "/api/ws") {
      const sid = await verifySessionFromRequest(req, env.SESSION_HMAC_SECRET);
      if (!sid) return new Response("Unauthorized", { status: 401 });
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 400 });
      }
      return getHub(env).fetch(req);
    }

    if (url.pathname === "/api/pixel" && req.method === "POST") {
      // Auth
      const sid = await verifySessionFromRequest(req, env.SESSION_HMAC_SECRET);
      if (!sid) return json({ error: "unauthorized" }, { status: 401 });

      // [Path B fallback]: if not using WAF Rate Limiting, uncomment:
      // const { success } = await env.PAINT_LIMITER!.limit({ key: sid });
      // if (!success) {
      //   return json({ error: "rate_limited" }, {
      //     status: 429,
      //     headers: { "Retry-After": "5" },
      //   });
      // }

      const body = (await req.json().catch(() => ({}))) as {
        x?: number; y?: number; color?: number;
      };
      const { x, y, color } = body;
      if (
        typeof x !== "number" || typeof y !== "number" || typeof color !== "number" ||
        x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE ||
        !isValidColorIndex(color)
      ) {
        return json({ error: "bad request" }, { status: 400 });
      }

      const tileCol = (x / TILE_SIZE) | 0;
      const tileRow = (y / TILE_SIZE) | 0;
      const tileId = tileRow * TILES_PER_ROW + tileCol;
      const localX = x % TILE_SIZE;
      const localY = y % TILE_SIZE;

      const tile = env.TILE.get(env.TILE.idFromName(`tile-${tileId}`));
      await tile.setPixel(localX, localY, color);

      // Broadcast (fire-and-forget after persist)
      ctx.waitUntil(getHub(env).broadcast(x, y, color));

      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/api/board/clear" && req.method === "POST") {
      const sid = await verifySessionFromRequest(req, env.SESSION_HMAC_SECRET);
      if (!sid) return json({ error: "unauthorized" }, { status: 401 });

      await Promise.all(
        Array.from({ length: TILES_PER_ROW * TILES_PER_ROW }, (_, i) =>
          env.TILE.get(env.TILE.idFromName(`tile-${i}`)).reset()
        )
      );
      ctx.waitUntil(getHub(env).broadcastClear());
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/api/recognize" && req.method === "POST") {
      // Auth — keep this on a dedicated path so you can drop Cloudflare Access in front
      const sid = await verifySessionFromRequest(req, env.SESSION_HMAC_SECRET);
      if (!sid) return json({ error: "unauthorized" }, { status: 401 });

      // Aggregate board from tiles in parallel
      const tiles = await Promise.all(
        Array.from({ length: TILES_PER_ROW * TILES_PER_ROW }, (_, i) =>
          env.TILE.get(env.TILE.idFromName(`tile-${i}`)).getState()
        )
      );
      const board = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
      for (let i = 0; i < tiles.length; i++) {
        const tr = (i / TILES_PER_ROW) | 0;
        const tc = i % TILES_PER_ROW;
        const data = tiles[i];
        for (let py = 0; py < TILE_SIZE; py++) {
          const gy = tr * TILE_SIZE + py;
          const dst = gy * BOARD_SIZE + tc * TILE_SIZE;
          const src = py * TILE_SIZE;
          board.set(data.subarray(src, src + TILE_SIZE), dst);
        }
      }

      const png = await boardToPNG(board, PALETTE_RGBA);
      const dataUrl = `data:image/png;base64,${btoa(
        String.fromCharCode(...png)
      )}`;

      const prompt =
        "This is a 64×64 pixel art image (upscaled 8× for clarity). " +
        "What do you see? The image might contain multple drawings. Answer in 5 words or fewer for each drawing.";

      const buildMessages = () => [
        {
          role: "user" as const,
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ];

      const startKimi = Date.now();
      const startGemma = Date.now();

      const [kimiRes, gemmaRes] = await Promise.allSettled([
        env.AI.run("@cf/moonshotai/kimi-k2.6" as any, {
          messages: buildMessages(),
          max_tokens: 10000,
        } as any),
        env.AI.run("@cf/google/gemma-4-26b-a4b-it" as any, {
          messages: buildMessages(),
          max_tokens: 1024,
        } as any),
      ]);

      const stripThinking = (s: string) =>
        s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

      const extract = (label: string, r: PromiseSettledResult<any>): string => {
        console.log(`[${label}] status:`, r.status);
        if (r.status === "rejected") {
          console.log(`[${label}] rejected reason:`, String(r.reason));
          return `error: ${String(r.reason)}`;
        }
        const v = r.value as any;
        console.log(`[${label}] typeof value:`, typeof v);
        console.log(`[${label}] raw JSON:`, JSON.stringify(v).slice(0, 2000));

        if (typeof v === "string") {
          console.log(`[${label}] branch: string`);
          return stripThinking(v);
        }
        if (v?.response) {
          console.log(`[${label}] branch: v.response`);
          return stripThinking(v.response);
        }
        if (v?.choices?.[0]?.message) {
          const msg = v.choices[0].message;
          console.log(`[${label}] message keys:`, Object.keys(msg));
          console.log(`[${label}] finish_reason:`, v.choices[0].finish_reason);
          console.log(`[${label}] content:`, JSON.stringify(msg.content)?.slice(0, 500));
          console.log(`[${label}] reasoning_content:`, JSON.stringify(msg.reasoning_content)?.slice(0, 500));
          console.log(`[${label}] reasoning:`, JSON.stringify(msg.reasoning)?.slice(0, 500));
          const c = msg.content ?? msg.reasoning_content ?? msg.reasoning;
          if (c) {
            if (typeof c === "string") {
              console.log(`[${label}] branch: choices content string, length:`, c.length);
              return stripThinking(c);
            }
            if (Array.isArray(c)) {
              console.log(`[${label}] branch: choices content array, length:`, c.length);
              return stripThinking(c.map((p: any) => p?.text ?? "").join(" "));
            }
          }
        }
        console.log(`[${label}] branch: fallback JSON`);
        return JSON.stringify(v).slice(0, 200);
      };

      return json({
        kimi: extract("kimi", kimiRes),
        gemma: extract("gemma", gemmaRes),
        latency: {
          kimi: Date.now() - startKimi,
          gemma: Date.now() - startGemma,
        },
      });
    }

    // -------- Static assets --------
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
