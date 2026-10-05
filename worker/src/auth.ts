// Session-token (JWT) verification for requests from the Shopify UI extensions,
// and HMAC signing for /pay links.

import type { Env } from "./env";

const enc = new TextEncoder();

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToB64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function hmacKey(secret: string, usage: ("sign" | "verify")[]) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

/**
 * Verifies a Shopify UI-extension session token (HS256, signed with the app's client secret).
 * Returns the payload, or null if invalid.
 */
export async function verifySessionToken(env: Env, authHeader: string | null): Promise<Record<string, any> | null> {
  const token = authHeader?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;

  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    if (header.alg !== "HS256") return null;

    const key = await hmacKey(env.SHOPIFY_CLIENT_SECRET, ["verify"]);
    const ok = await crypto.subtle.verify("HMAC", key, b64urlToBytes(s), enc.encode(`${h}.${p}`));
    if (!ok) return null;

    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
    const nowSec = Math.floor(Date.now() / 1000);
    const skew = 10;
    if (typeof payload.exp !== "number" || payload.exp < nowSec - skew) return null;
    if (typeof payload.nbf === "number" && payload.nbf > nowSec + skew) return null;
    if (payload.aud !== env.SHOPIFY_CLIENT_ID) return null;

    const dest = String(payload.dest ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (dest !== env.SHOPIFY_SHOP) return null;

    return payload;
  } catch {
    return null;
  }
}

// ---------- signed pay links ----------

const LINK_TTL_SECONDS = 60 * 60 * 24; // links stay valid for a day

async function sign(env: Env, data: string): Promise<string> {
  const key = await hmacKey(env.LINK_SECRET, ["sign"]);
  return bytesToB64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export async function signedPayUrl(env: Env, orderId: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
  const sig = await sign(env, `${orderId}.${exp}`);
  return `${env.PUBLIC_URL}/pay/${orderId}?exp=${exp}&sig=${sig}`;
}

export async function verifyPayUrl(env: Env, orderId: string, exp: string | null, sig: string | null): Promise<boolean> {
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = await sign(env, `${orderId}.${exp}`);
  // constant-time compare
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}
