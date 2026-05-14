import puppeteer from "@cloudflare/puppeteer";
import {
  validateTurnstile,
  issueSessionCookie,
  verifySessionFromRequest,
  createSessionValue,
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
  CF_AI_GATEWAY_ID: string;
  BROWSER: Fetcher;
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

    if (url.pathname === "/draw.html") {
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname === "/draw" && req.method === "GET") {
      const jwt = req.headers.get("CF-Access-Jwt-Assertion") ?? "";
      const ok = await verifyAccessJwt(jwt, env.CF_TEAM_DOMAIN, env.CF_ACCESS_AUD);
      if (!ok) return new Response("Unauthorized", { status: 401 });
      return env.ASSETS.fetch(new Request(new URL("/draw.html", req.url).toString()));
    }

    // -------- API routes --------
    if (url.pathname === "/api/whoami" && req.method === "GET") {
      const sid = await verifySessionFromRequest(req, env.SESSION_HMAC_SECRET);
      // Extract email from Cloudflare Access. The CF-Access-Jwt-Assertion header is only
      // injected on paths inside the Access app scope, but CF_Authorization cookie is sent
      // on every request to the domain by the browser after login — decode from there.
      const decodeAccessEmail = (jwt: string): string | null => {
        try {
          const b64 = (s: string) => s.replace(/-/g, "+").replace(/_/g, "/");
          const payload = JSON.parse(atob(b64(jwt.split(".")[1] ?? "")));
          return typeof payload.email === "string" ? payload.email : null;
        } catch { return null; }
      };
      let accessEmail: string | null =
        req.headers.get("cf-access-authenticated-user-email") ??
        decodeAccessEmail(req.headers.get("cf-access-jwt-assertion") ?? "");
      if (!accessEmail) {
        // CF_Authorization cookie carries the same JWT for all paths
        const cookieHeader = req.headers.get("cookie") ?? "";
        const cookieMatch = cookieHeader.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
        if (cookieMatch) accessEmail = decodeAccessEmail(cookieMatch[1]);
      }
      return json({
        authenticated: sid !== null,
        siteKey: env.TURNSTILE_SITE_KEY,
        palette: PALETTE,
        accessEmail,
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

      const aiGateway = env.CF_AI_GATEWAY_ID ? { gateway: { id: env.CF_AI_GATEWAY_ID } } : undefined;
      const [kimiRes, gemmaRes] = await Promise.allSettled([
        env.AI.run("@cf/moonshotai/kimi-k2.6" as any, {
          messages: buildMessages(),
          max_tokens: 10000,
        } as any, aiGateway as any),
        env.AI.run("@cf/google/gemma-4-26b-a4b-it" as any, {
          messages: buildMessages(),
          max_tokens: 1024,
        } as any, aiGateway as any),
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

    if (url.pathname === "/api/draw" && req.method === "POST") {
      const sid = await verifySessionFromRequest(req, env.SESSION_HMAC_SECRET);
      if (!sid) return json({ error: "unauthorized" }, { status: 401 });

      const body = (await req.json().catch(() => ({}))) as { prompt?: string };
      const prompt = body.prompt?.trim();
      if (!prompt) return json({ error: "missing prompt" }, { status: 400 });

      try {

      // Step 1: LLM generates pixel art coordinates
      const drawGateway = env.CF_AI_GATEWAY_ID ? { gateway: { id: env.CF_AI_GATEWAY_ID } } : undefined;
      const llmResult = await env.AI.run("@cf/moonshotai/kimi-k2.6" as any, {
        messages: [
          {
            role: "system",
            content:
              "You are a pixel artist. Output ONLY raw JSON — no markdown, no explanation.\n" +
              "Format: {\"pixels\":[{\"x\":N,\"y\":N,\"color\":N},...]}",
          },
          {
            role: "user",
            content:
              `Draw "${prompt}" as pixel art, in a random place of a 256x256 canvas. ` +
              "Use at most 25x25 pixels. Skip color 0 (white = background). " +
              "Palette: 0=white, 1=light gray, 2=gray, 3=black, 4=pink, 5=red, " +
              "6=orange, 7=brown, 8=yellow, 9=light green, 10=green, 11=cyan, " +
              "12=blue, 13=dark blue, 14=magenta, 15=purple. " +
              "x and y must be integers 0–63. color must be integer 0–15.",
          },
        ],
        max_tokens: 20000,
      } as any, drawGateway as any);

      // Extract text from AI response
      const rawText = (() => {
        const v = llmResult as any;
        if (typeof v === "string") return v;
        if (v?.response) return v.response;
        if (v?.choices?.[0]?.message?.content) return String(v.choices[0].message.content);
        return JSON.stringify(v);
      })();

      // Extract pixel objects with a regex — tolerates truncated JSON, markdown fences, extra text.
      type Pixel = { x: number; y: number; color: number };
      const pixelRegex = /"x"\s*:\s*(\d+)\s*,\s*"y"\s*:\s*(\d+)\s*,\s*"color"\s*:\s*(\d+)/g;
      const pixels: Pixel[] = [];
      let m;
      while ((m = pixelRegex.exec(rawText)) !== null) {
        const x = parseInt(m[1], 10);
        const y = parseInt(m[2], 10);
        const color = parseInt(m[3], 10);
        if (x >= 0 && x < 64 && y >= 0 && y < 64 && color >= 0 && color <= 15) {
          pixels.push({ x, y, color });
        }
      }
      console.log(`[draw] LLM raw (first 800 chars):`, rawText.slice(0, 800));
      console.log(`[draw] extracted ${pixels.length} pixels:`, JSON.stringify(pixels));

      if (pixels.length === 0) {
        return json({ error: "AI generated no valid pixels", raw: rawText.slice(0, 500) }, { status: 500 });
      }

      // Step 2: Browser draws the pixels via the public /api/pixel endpoint
      const sessionValue = await createSessionValue(env.SESSION_HMAC_SECRET);
      const boardOrigin = `${url.protocol}//${url.host}`;
      const browser = await puppeteer.launch(env.BROWSER as any);
      const browserLogs: string[] = [];
      let drawn = 0;
      try {
        const page = await browser.newPage();

        // Capture browser console for debugging
        page.on("console", (msg) => {
          const entry = `[browser:${msg.type()}] ${msg.text()}`;
          console.log(entry);
          browserLogs.push(entry);
        });

        await page.setCookie({
          name: "pb_session",
          value: sessionValue,
          domain: url.hostname,
          path: "/",
          httpOnly: true,
          secure: url.protocol === "https:",
          sameSite: "Strict",
        });

        console.log(`[draw] navigating to ${boardOrigin}`);
        await page.goto(boardOrigin, { waitUntil: "load" });

        const result = await page.evaluate(
          async (pixelList: Pixel[], origin: string) => {
            const log: string[] = [];
            let ok = 0, fail = 0;
            for (const { x, y, color } of pixelList) {
              try {
                const res = await (fetch as any)(`${origin}/api/pixel`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "x-pixel-id": `${x},${y}` },
                  body: JSON.stringify({ x, y, color }),
                  credentials: "include",
                });
                if (res.ok) {
                  ok++;
                } else {
                  const body = await res.text().catch(() => "");
                  log.push(`FAIL ${res.status} (${x},${y},c${color}): ${body.slice(0, 80)}`);
                  fail++;
                }
              } catch (e) {
                log.push(`ERR (${x},${y},c${color}): ${String(e)}`);
                fail++;
              }
            }
            console.log(`[browser] ok=${ok} fail=${fail}`);
            log.forEach((l) => console.log(l));
            return { ok, fail, log };
          },
          pixels,
          boardOrigin
        );
        drawn = result.ok;
        console.log(`[draw] browser done: ok=${result.ok} fail=${result.fail}`);
        if (result.log.length) console.log(`[draw] browser errors:`, result.log.join(" | "));
      } finally {
        await browser.close();
      }

      return json({
        ok: true,
        prompt,
        pixelsPlanned: pixels.length,
        pixelsDrawn: drawn,
        pixels,             // full pixel plan — compare with what you see on the board
        browserLogs,
      });

      } catch (err) {
        console.error("[draw] unhandled error:", String(err));
        return json({ error: String(err) }, { status: 500 });
      }
    }

    // -------- Static assets --------
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
