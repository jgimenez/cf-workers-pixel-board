# Pixel AI — Cloudflare Hackathon Project

A real-time collaborative pixel art board built entirely on Cloudflare Workers. Users paint on a shared 64×64 canvas and see each other's strokes live. The twist: two AI models watch the board and can describe what's on it, and a third AI model can paint on the board itself when given a text prompt.

Built as part of the **Cloudflare Peer Point Barcelona Hackathon**.

---

## How it works

- Open the board and pass a Turnstile bot-protection challenge to unlock painting.
- Pick a color from the 16-color palette and click any pixel — your stroke is persisted and broadcast to every connected client in real time.
- Hit **Recognize** to ask two vision models what they see on the canvas.
- Use the **Draw** page (Access-protected) to type a prompt and let the AI paint it for you.

---

## Cloudflare technologies

| Technology | Role |
|---|---|
| **Workers** | All backend logic — routing, auth, pixel writes, AI calls |
| **Durable Objects (SQLite)** | Two DO classes: `Tile` owns a 16×16 pixel region (16 tiles tile the 64×64 board); `BoardHub` manages WebSocket connections and fans out pixel updates to every viewer |
| **Workers Assets** | Serves the static frontend (HTML, CSS, JS) with SPA fallback |
| **Workers AI** | Runs `@cf/moonshotai/kimi-k2.6` and `@cf/google/gemma-4-26b-a4b-it` for board recognition, and Kimi K2.6 again to generate pixel coordinates from a text prompt |
| **AI Gateway** | Routes all Workers AI calls through a named gateway for request logging and observability |
| **Browser Rendering** | A headless Puppeteer browser runs inside the Worker to execute the AI-generated pixel plan against the live `/api/pixel` endpoint |
| **Turnstile** | Bot-protection challenge gate before a user can paint |
| **Cloudflare Access** | Zero Trust JWT authentication for the `/admin` and `/draw` routes |
| **WAF Rate Limiting** | Per-session rate limiting on pixel paint requests (Workers Rate Limiting binding available as a fallback) |
| **Observability Logs** | Invocation and Worker logs enabled for debugging |

---

## Architecture highlights

- The board is split into 16 independent `Tile` Durable Objects (each owning a 16×16 region). Writes are localized to a single tile; reads fan out in parallel across all tiles.
- `BoardHub` is a single Durable Object that holds all active WebSocket connections and broadcasts binary pixel-update messages (`[0x01, x, y, color]`, 4 bytes) to every viewer.
- Sessions are stateless HMAC-SHA-256 signed cookies — no database needed for auth.
- The AI draw flow is intentionally two-step: the LLM outputs pixel coordinates as JSON, then a Browser Rendering instance actually POSTs each pixel through the normal authenticated API path, so rate limits and validation apply uniformly.

---

## Running locally

```bash
npm install
npx wrangler dev
```

Secrets required for full functionality (set via `wrangler secret put`):

- `TURNSTILE_SECRET` — from the Turnstile dashboard
- `SESSION_HMAC_SECRET` — any random string (e.g. `openssl rand -hex 32`)
