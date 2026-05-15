# Pixel AI — Cloudflare Hackathon Project

A real-time collaborative pixel art board built entirely on Cloudflare Workers. Users paint on a shared 64×64 canvas and see each other's strokes live. Three AI features sit on top: vision recognition of the board, text-to-pixel-art drawing, and image-to-pixel-art drawing powered by Flux 2 and a Gemma-authored Dynamic Worker.

Built as part of the **Cloudflare Peer Point Barcelona Hackathon**.

---

## Features

- **Collaborative canvas** — 64×64 pixel board, 16-color palette, live updates via WebSocket to every connected viewer.
- **Turnstile bot protection** — challenge gate before painting is unlocked.
- **Recognize** — asks two vision models (Kimi K2.6 + Gemma 4) what they see on the canvas.
- **Draw (text)** — type a prompt, Kimi K2.6 generates pixel coordinates, a Puppeteer browser paints them on the live board.
- **Draw Image** — type a prompt, Flux 2 generates a photo-realistic image, Gemma 4 writes a Dynamic Worker that paints it onto the board pixel by pixel.

---

## AI features in depth

### Recognize (`/api/recognize`)

Captures the board as a 512×512 PNG (upscaled 8× for clarity) and sends it to two vision models in parallel:

- `@cf/moonshotai/kimi-k2.6` — long-context reasoning model
- `@cf/google/gemma-4-26b-a4b-it` — multimodal model

Both describe what they see in five words or fewer per drawing. Results are shown side by side on the board.

### Draw — text to pixel art (`/api/draw`)

1. Kimi K2.6 receives the prompt and returns a JSON list of `{x, y, color}` pixel coordinates placed anywhere on the 64×64 canvas.
2. A **Browser Rendering** (Puppeteer) instance opens the board page, authenticates with a short-lived HMAC session cookie, and POSTs each pixel through the standard `/api/pixel` endpoint — so rate limiting and validation apply exactly as for a human painter.

### Draw Image — Flux 2 + Gemma Dynamic Worker (`/api/draw-image` + `/api/draw-pixels`)

This is the main new AI feature and uses four Cloudflare products working together:

**Step 1 — Image generation (`/api/draw-image`)**

The user's prompt is sent to **`@cf/black-forest-labs/flux-2-klein-9b`**, a distilled 4-step Flux 2 model. It returns a 256×256 JPEG. The raw image is returned to the browser as a data URL so the user can see what Flux generated.

> Flux 2 requires multipart/form-data input, not JSON — a `FormData` object is serialised through a `Response` to obtain the correct `content-type` boundary before calling `env.AI.run()`. The AI Gateway does not support `ReadableStream` bodies, so Flux is called without the gateway.

**Step 2 — Browser-side decoding**

The browser draws the Flux JPEG onto a `<canvas>` scaled to 64×64 and reads back the raw RGBA pixel array (`ImageData.data`). This offloads JPEG decoding to the browser's native engine — no server-side image codec needed.

**Step 3 — Quantisation in the main worker (`/api/draw-pixels`)**

The 64×64 RGBA array arrives at the server. The main Worker converts each pixel to the closest colour in the 16-colour palette using squared Euclidean RGB distance, producing a list of `{x, y, color}` objects. Only non-white pixels (index ≠ 0) are kept.

**Step 4 — Gemma writes the painting code**

`@cf/google/gemma-4-26b-a4b-it` is asked to write the **body** of a single JavaScript function:

```js
async function paintPixels(pixels, origin, sessionCookie) {
  // use Promise.allSettled to POST each {x,y,color} to origin+'/api/pixel'
  // return the count of successful responses
}
```

Gemma writes only the function body — the surrounding Worker shell (ES module structure, `try/catch`, JSON response) is hardcoded by the server, so Gemma cannot introduce TypeScript syntax or structural errors.

**Step 5 — Dynamic Worker executes Gemma's code**

The assembled ES module is loaded on the fly using the **Worker Loader API** (`env.LOADER.load()`):

```ts
const worker = env.LOADER.load({
  compatibilityDate: "2026-05-01",
  mainModule: "worker.js",
  modules: { "worker.js": gemmaCode },
  globalOutbound: env.SELF_SERVICE,   // all fetch() calls routed through SELF_SERVICE
});
const result = await worker.getEntrypoint().fetch(request);
```

`globalOutbound` is set to `SELF_SERVICE` — a **Service Binding** that points back to the same Worker. This means every `fetch()` call the Dynamic Worker makes is handled internally by our own Worker without leaving the Cloudflare network, so the `/api/pixel` authentication, validation, and Durable Object writes all behave exactly as for a human painter.

---

## Cloudflare technologies

| Technology | Role |
|---|---|
| **Workers** | All backend logic — routing, auth, pixel writes, AI calls |
| **Durable Objects (SQLite)** | `Tile` owns a 16×16 pixel region (16 tiles cover the 64×64 board); `BoardHub` manages WebSocket fan-out |
| **Workers Assets** | Serves the static frontend with SPA fallback |
| **Workers AI** | `@cf/moonshotai/kimi-k2.6` for recognition + text drawing; `@cf/google/gemma-4-26b-a4b-it` for recognition + code generation; `@cf/black-forest-labs/flux-2-klein-9b` for image generation |
| **Dynamic Workers (Worker Loader API)** | Loads and executes Gemma's AI-generated painting code in an isolated sandbox at runtime |
| **Service Bindings** | Self-referencing binding (`SELF_SERVICE`) used as `globalOutbound` so the Dynamic Worker's fetch calls are routed back through the main Worker |
| **AI Gateway** | Routes Workers AI calls (except Flux) through a named gateway for request logging and observability |
| **Browser Rendering** | Puppeteer browser paints text-prompt pixel art through the live `/api/pixel` endpoint |
| **Turnstile** | Bot-protection challenge gate before painting |
| **Cloudflare Access** | Zero Trust JWT auth on the `/draw` and `/admin` routes |
| **WAF Rate Limiting** | Per-session rate limiting on pixel paint requests |
| **Observability Logs** | Invocation and Worker logs; use `wrangler tail --format pretty` for live debugging |

---

## Architecture

```
Browser
  │
  ├─ WebSocket (/api/ws) ──► BoardHub DO ──► broadcast to all viewers
  │
  ├─ POST /api/pixel ──► Tile DO (1 of 16) ──► persist + broadcast
  │
  ├─ POST /api/recognize ──► Workers AI (Kimi + Gemma, vision)
  │
  ├─ POST /api/draw ──► Kimi K2.6 (pixel plan) ──► Browser Rendering ──► /api/pixel
  │
  └─ POST /api/draw-image ──► Flux 2 (256×256 JPEG) ──► browser
     POST /api/draw-pixels ──► quantise RGBA ──► Gemma (writes paintPixels body)
                            ──► Worker Loader (Dynamic Worker, globalOutbound=SELF_SERVICE)
                            ──► /api/pixel × N (internal, through SELF_SERVICE)
```

The board is split into 16 independent `Tile` Durable Objects (each owning a 16×16 region). Writes are localised to a single tile; the initial snapshot fans out across all tiles in parallel.

Sessions are stateless HMAC-SHA-256 signed cookies — no database required for auth.

---

## Running locally

```bash
npm install
npx wrangler dev
```

Secrets required (set via `wrangler secret put`):

- `TURNSTILE_SECRET` — from the Turnstile dashboard
- `SESSION_HMAC_SECRET` — any random string (`openssl rand -hex 32`)

To stream live Worker logs during development or in production:

```bash
npx wrangler tail --format pretty
```
