export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with jitter, capped at 5 minutes — CLAUDE.md §4 Failure handling. */
export function backoffMs(attempt: number, capMs = 5 * 60_000): number {
  const base = Math.min(1000 * 2 ** attempt, capMs);
  return base + Math.random() * base * 0.2;
}
