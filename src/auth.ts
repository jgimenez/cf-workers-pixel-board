// Turnstile validation + HMAC-signed session cookie.
//
// Cookie format: pb_session=<uuid>.<base64url(hmac-sha256(uuid, secret))>
// Why this format: the WAF Rate Limiting Rule keys on the entire cookie value,
// so different users get different counters automatically.

const COOKIE_NAME = "pb_session";
const COOKIE_MAX_AGE = 24 * 60 * 60; // 24h

export interface Env {
  TURNSTILE_SECRET: string;
  SESSION_HMAC_SECRET: string;
}

export async function validateTurnstile(
  token: string,
  ip: string,
  secret: string
): Promise<boolean> {
  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (ip) form.set("remoteip", ip);
  const res = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body: form }
  );
  if (!res.ok) return false;
  const data = (await res.json()) as { success?: boolean };
  return data.success === true;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function b64url(bytes: ArrayBuffer): string {
  const b = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(sessionId: string, secret: string): Promise<string> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(sessionId)
  );
  return b64url(sig);
}

export async function createSessionValue(secret: string): Promise<string> {
  const sessionId = crypto.randomUUID();
  const sig = await sign(sessionId, secret);
  return `${sessionId}.${sig}`;
}

export async function issueSessionCookie(secret: string): Promise<string> {
  const sessionId = crypto.randomUUID();
  const sig = await sign(sessionId, secret);
  const value = `${sessionId}.${sig}`;
  return [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${COOKIE_MAX_AGE}`,
  ].join("; ");
}

export async function verifySessionFromRequest(
  req: Request,
  secret: string
): Promise<string | null> {
  const cookie = req.headers.get("Cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  const value = match[1];
  const dot = value.lastIndexOf(".");
  if (dot < 0) return null;
  const sessionId = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!sessionId || !sig) return null;
  const expected = await sign(sessionId, secret);
  // Constant-time compare
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0 ? sessionId : null;
}
