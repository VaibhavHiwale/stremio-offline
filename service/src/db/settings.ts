import type { Settings } from "@stremio-offline/shared";
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

interface RawSettingsRow {
  wifiOnly: number;
  defaultQuality: string;
  autoDownloadNextEpisode: number;
  autoDownloadLookahead: number;
  autoDeleteAfterWatch: number;
  autoDeleteAfterDays: number | null;
  maxConcurrentDownloads: number;
  maxConcurrentRemuxes: number;
  defaultStorageTargetId: string | null;
  subtitleLangs: string;
  openSubtitlesApiKey: string | null;
  publicBaseUrl: string | null;
  legalNoticeAcceptedAt: string | null;
}

const SETTINGS_COLUMNS = `
  wifi_only AS wifiOnly, default_quality AS defaultQuality,
  auto_download_next_episode AS autoDownloadNextEpisode, auto_download_lookahead AS autoDownloadLookahead,
  auto_delete_after_watch AS autoDeleteAfterWatch, auto_delete_after_days AS autoDeleteAfterDays,
  max_concurrent_downloads AS maxConcurrentDownloads, max_concurrent_remuxes AS maxConcurrentRemuxes,
  default_storage_target_id AS defaultStorageTargetId, subtitle_langs AS subtitleLangs,
  open_subtitles_api_key AS openSubtitlesApiKey, public_base_url AS publicBaseUrl,
  legal_notice_accepted_at AS legalNoticeAcceptedAt
`;

export function getSettings(db: Database): Settings {
  const row = db.prepare(`SELECT ${SETTINGS_COLUMNS} FROM settings WHERE id = 1`).get() as RawSettingsRow;
  return {
    wifiOnly: Boolean(row.wifiOnly),
    defaultQuality: row.defaultQuality as Settings["defaultQuality"],
    autoDownloadNextEpisode: Boolean(row.autoDownloadNextEpisode),
    autoDownloadLookahead: row.autoDownloadLookahead,
    autoDeleteAfterWatch: Boolean(row.autoDeleteAfterWatch),
    autoDeleteAfterDays: row.autoDeleteAfterDays,
    maxConcurrentDownloads: row.maxConcurrentDownloads,
    maxConcurrentRemuxes: row.maxConcurrentRemuxes,
    // Schema allows NULL (no default target chosen yet); P8's ensureDefaultTarget
    // always registers a target literally named "default", so that's the fallback.
    defaultStorageTargetId: row.defaultStorageTargetId ?? "default",
    subtitleLangs: JSON.parse(row.subtitleLangs) as string[],
    openSubtitlesApiKey: row.openSubtitlesApiKey,
    publicBaseUrl: row.publicBaseUrl,
    legalNoticeAcceptedAt: row.legalNoticeAcceptedAt,
  };
}

// Whitelisted column map — never build SQL from caller-supplied field
// names, only ever pick from this fixed set.
const SETTINGS_COLUMN_MAP: Record<string, string> = {
  wifiOnly: "wifi_only",
  defaultQuality: "default_quality",
  autoDownloadNextEpisode: "auto_download_next_episode",
  autoDownloadLookahead: "auto_download_lookahead",
  autoDeleteAfterWatch: "auto_delete_after_watch",
  autoDeleteAfterDays: "auto_delete_after_days",
  maxConcurrentDownloads: "max_concurrent_downloads",
  maxConcurrentRemuxes: "max_concurrent_remuxes",
  defaultStorageTargetId: "default_storage_target_id",
  subtitleLangs: "subtitle_langs",
  openSubtitlesApiKey: "open_subtitles_api_key",
  publicBaseUrl: "public_base_url",
};

function toColumnValue(field: string, value: unknown): unknown {
  if (field === "subtitleLangs") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

/** Partial update — only the fields present in `patch` are touched. `legalNoticeAcceptedAt` is intentionally not settable here (see legal.ts's acceptLegalNotice). */
export function updateSettings(db: Database, patch: Partial<Settings>): Settings {
  const fields = Object.keys(patch).filter((key) => key in SETTINGS_COLUMN_MAP);
  if (fields.length > 0) {
    const setClause = fields.map((field) => `${SETTINGS_COLUMN_MAP[field]} = ?`).join(", ");
    const values = fields.map((field) => toColumnValue(field, (patch as Record<string, unknown>)[field]));
    db.prepare(`UPDATE settings SET ${setClause} WHERE id = 1`).run(...values);
  }
  return getSettings(db);
}
