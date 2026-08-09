import type { Database } from "better-sqlite3";

/** Read live (not cached) so a future PATCH /settings takes effect without a restart. */
export function getMaxConcurrentDownloads(db: Database): number {
  const row = db.prepare("SELECT max_concurrent_downloads AS value FROM settings WHERE id = 1").get() as
    | { value: number }
    | undefined;
  return row?.value ?? 2;
}

/** Null when the user hasn't configured one — P7 subtitle fetching is skipped, not an error, in that case (CLAUDE.md §5: "user-supplied key"). */
export function getOpenSubtitlesApiKey(db: Database): string | null {
  const row = db.prepare("SELECT open_subtitles_api_key AS value FROM settings WHERE id = 1").get() as
    | { value: string | null }
    | undefined;
  return row?.value ?? null;
}

export function getDefaultSubtitleLangs(db: Database): string[] {
  const row = db.prepare("SELECT subtitle_langs AS value FROM settings WHERE id = 1").get() as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as string[]) : ["en"];
}
