import type { DebridService } from "@stremio-offline/shared";

/**
 * Outcome of asking a debrid service to turn a magnet into a direct HTTPS
 * URL — CLAUDE.md §3 Rule 7. Three shapes, not two, because caching a
 * torrent on the debrid side can take real time: `pending` is neither
 * success nor failure, it means "ask again shortly."
 */
export type ResolveOutcome =
  | { status: "ready"; directUrl: string }
  | { status: "pending"; message: string }
  | { status: "error"; message: string; retryable: boolean };

export interface DebridResolver {
  readonly service: DebridService;
  resolveMagnet(apiKey: string, magnetUri: string, fetchImpl?: typeof fetch): Promise<ResolveOutcome>;
}

/** Pulls the BTIH info hash out of a magnet URI (`magnet:?xt=urn:btih:<hash>&...`) — several debrid APIs key on this instead of the raw magnet string. */
export function extractInfoHash(magnetUri: string): string | null {
  const match = /xt=urn:btih:([a-zA-Z0-9]+)/.exec(magnetUri);
  return match?.[1]?.toLowerCase() ?? null;
}

/** An HTTP-status-shaped error (`"HTTP 429"` etc.) — retryable per the same 429/5xx rule as the main HTTP downloader (CLAUDE.md §4). */
export function classifyHttpStatusError(message: string): ResolveOutcome {
  const status = Number(/HTTP (\d+)/.exec(message)?.[1] ?? 0);
  const retryable = status === 429 || (status >= 500 && status < 600);
  return { status: "error", message, retryable };
}

/** An API-level error with no HTTP status to key off (bad request, auth failure, quota, ...). Defaults to non-retryable — CLAUDE.md §4: never burn retry budget on a terminal error, and an unrecognized error is safer treated as terminal than looped on forever. */
export function errorOutcome(message: string, retryable = false): ResolveOutcome {
  return { status: "error", message, retryable };
}
