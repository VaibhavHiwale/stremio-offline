import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed query-string tokens for authenticated file access — CLAUDE.md §3
 * Rule 4. `proxyHeaders` isn't honoured by the Stremio Web player and
 * requires notWebReady, which Rule 1 forbids, so this is the only
 * authentication mechanism `/files/:id` uses, and it behaves identically on
 * every client.
 */

function sign(secret: string, id: string, expiresAt: number): string {
  return createHmac("sha256", secret).update(`${id}.${expiresAt}`).digest("hex");
}

export function signFileToken(secret: string, id: string, ttlSeconds: number): { token: string; expiresAt: number } {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  return { token: sign(secret, id, expiresAt), expiresAt };
}

export function verifyFileToken(secret: string, id: string, expiresAt: number, token: string): boolean {
  if (!Number.isFinite(expiresAt) || Math.floor(Date.now() / 1000) > expiresAt) return false;

  const expected = Buffer.from(sign(secret, id, expiresAt), "hex");
  let provided: Buffer;
  try {
    provided = Buffer.from(token, "hex");
  } catch {
    return false;
  }
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}
