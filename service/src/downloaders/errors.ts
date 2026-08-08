/**
 * Retryable vs terminal error classification — CLAUDE.md §4 Failure handling.
 * Retryable: timeout, 5xx, 429, connection reset, DNS. Terminal: everything
 * else (401 bad token, 402 quota, 404, DRM detected, etc.) — never burn
 * retry budget on those.
 */

const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

// Errors specifically caused by loss of network connectivity — these pause
// rather than count against the retry budget. A subset of RETRYABLE_CODES.
const NETWORK_LOSS_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_SOCKET"]);

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

export function isRetryableError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  // Node's fetch wraps underlying causes; check one level down too.
  const cause = (err as { cause?: { code?: string } } | undefined)?.cause;
  if (cause?.code && RETRYABLE_CODES.has(cause.code)) return true;
  return false;
}

export function isNetworkLossError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  if (code && NETWORK_LOSS_CODES.has(code)) return true;
  const cause = (err as { cause?: { code?: string } } | undefined)?.cause;
  if (cause?.code && NETWORK_LOSS_CODES.has(cause.code)) return true;
  return false;
}

/** A graceful shutdown aborting an in-flight download — resumable on the next boot, not a failure. */
export function isAbortError(err: unknown): boolean {
  return (err as { name?: string } | undefined)?.name === "AbortError";
}
