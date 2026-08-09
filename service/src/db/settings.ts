import type { Database } from "better-sqlite3";

/** Read live (not cached) so a future PATCH /settings takes effect without a restart. */
export function getMaxConcurrentDownloads(db: Database): number {
  const row = db.prepare("SELECT max_concurrent_downloads AS value FROM settings WHERE id = 1").get() as
    | { value: number }
    | undefined;
  return row?.value ?? 2;
}
