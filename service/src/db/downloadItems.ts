import type { DownloadItem } from "@stremio-offline/shared";
import type { Database } from "better-sqlite3";

export interface QueueRow {
  id: string;
  stremioId: string;
  seriesId: string | null;
  type: "movie" | "series";
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  quality: string;
  sourceKind: string;
  sourceUrl: string;
  sourceEtag: string | null;
  status: string;
  bytesDownloaded: number;
  bytesTotal: number | null;
  storageTargetId: string;
  filePathOriginal: string | null;
  attemptCount: number;
  priority: number;
  addedAt: string;
}

const ROW_COLUMNS = `
  id, stremio_id AS stremioId, series_id AS seriesId, type, title, year, season, episode,
  quality, source_kind AS sourceKind, source_url AS sourceUrl,
  source_etag AS sourceEtag, status, bytes_downloaded AS bytesDownloaded, bytes_total AS bytesTotal,
  storage_target_id AS storageTargetId, file_path_original AS filePathOriginal,
  attempt_count AS attemptCount, priority, added_at AS addedAt
`;

export function getById(db: Database, id: string): QueueRow | undefined {
  return db.prepare(`SELECT ${ROW_COLUMNS} FROM download_items WHERE id = ?`).get(id) as QueueRow | undefined;
}

// --- Full-shape reads for the REST API (P5) --------------------------------
// The queue internals above only ever need a handful of columns (QueueRow);
// GET /downloads and GET /downloads/:id are a public contract and return the
// complete DownloadItem shape from shared/types.ts instead.

interface RawFullRow extends Omit<DownloadItem, "subtitleLangs" | "retryableError" | "watched" | "autoDeleteAfterWatch"> {
  subtitleLangs: string; // JSON array, stored as TEXT
  retryableError: number; // SQLite has no boolean type
  watched: number;
  autoDeleteAfterWatch: number;
}

const FULL_ROW_COLUMNS = `
  id, stremio_id AS stremioId, series_id AS seriesId, type, title, year, season, episode, quality,
  source_kind AS sourceKind, source_url AS sourceUrl, source_etag AS sourceEtag, status,
  progress_pct AS progressPct, bytes_downloaded AS bytesDownloaded, bytes_total AS bytesTotal,
  speed_bps AS speedBps, eta_seconds AS etaSeconds, storage_target_id AS storageTargetId,
  file_path_original AS filePathOriginal, file_path_web_ready AS filePathWebReady, sha256,
  subtitle_langs AS subtitleLangs, attempt_count AS attemptCount, last_error AS lastError,
  retryable_error AS retryableError, watched, last_position_seconds AS lastPositionSeconds,
  last_watched_at AS lastWatchedAt, auto_delete_after_watch AS autoDeleteAfterWatch,
  priority, added_at AS addedAt, completed_at AS completedAt
`;

function toDownloadItem(row: RawFullRow): DownloadItem {
  return {
    ...row,
    subtitleLangs: JSON.parse(row.subtitleLangs) as string[],
    retryableError: Boolean(row.retryableError),
    watched: Boolean(row.watched),
    autoDeleteAfterWatch: Boolean(row.autoDeleteAfterWatch),
  };
}

export function getFullById(db: Database, id: string): DownloadItem | undefined {
  const row = db.prepare(`SELECT ${FULL_ROW_COLUMNS} FROM download_items WHERE id = ?`).get(id) as
    | RawFullRow
    | undefined;
  return row ? toDownloadItem(row) : undefined;
}

/** Newest-first — a management/dashboard view, not the scheduler's processing order. */
export function listAll(db: Database, opts: { status?: string } = {}): DownloadItem[] {
  const rows = opts.status
    ? (db
        .prepare(`SELECT ${FULL_ROW_COLUMNS} FROM download_items WHERE status = ? ORDER BY added_at DESC`)
        .all(opts.status) as RawFullRow[])
    : (db.prepare(`SELECT ${FULL_ROW_COLUMNS} FROM download_items ORDER BY added_at DESC`).all() as RawFullRow[]);
  return rows.map(toDownloadItem);
}

const ACTIVE_STATUSES = ["queued", "resolving", "downloading", "paused", "remuxing", "verifying"];

/** Everything still in flight — feeds the WS progress broadcast (P9). Excludes ready/failed/cancelled/deleted, which don't change once they get there. */
export function getActiveItems(db: Database): DownloadItem[] {
  const placeholders = ACTIVE_STATUSES.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT ${FULL_ROW_COLUMNS} FROM download_items WHERE status IN (${placeholders}) ORDER BY priority DESC, added_at ASC`)
    .all(...ACTIVE_STATUSES) as RawFullRow[];
  return rows.map(toDownloadItem);
}

/** Oldest-first within the highest priority band — the real scheduler (priority weighting, concurrency) is P5; this is P3's minimal single-lane picker. */
export function getNextQueued(db: Database): QueueRow | undefined {
  return db
    .prepare(`SELECT ${ROW_COLUMNS} FROM download_items WHERE status = 'queued' ORDER BY priority DESC, added_at ASC LIMIT 1`)
    .get() as QueueRow | undefined;
}

export function getInterruptedDownloads(db: Database): QueueRow[] {
  return db.prepare(`SELECT ${ROW_COLUMNS} FROM download_items WHERE status = 'downloading'`).all() as QueueRow[];
}

export function getPausedForNetworkLoss(db: Database): QueueRow[] {
  return db
    .prepare(`SELECT ${ROW_COLUMNS} FROM download_items WHERE status = 'paused' AND retryable_error = 1`)
    .all() as QueueRow[];
}

export function getRemuxingRows(db: Database): QueueRow[] {
  return db.prepare(`SELECT ${ROW_COLUMNS} FROM download_items WHERE status = 'remuxing'`).all() as QueueRow[];
}

/** Multiple candidates for the concurrent scheduler (P5) — same ordering as the single-row P3 picker, just not limited to one. */
export function getQueuedRows(db: Database, limit: number): QueueRow[] {
  return db
    .prepare(`SELECT ${ROW_COLUMNS} FROM download_items WHERE status = 'queued' ORDER BY priority DESC, added_at ASC LIMIT ?`)
    .all(limit) as QueueRow[];
}

export interface AutoDeleteCandidate {
  id: string;
  filePathOriginal: string | null;
  filePathWebReady: string | null;
}

/**
 * Ready downloads eligible for cleanup — CLAUDE.md §7's `autoDeleteAfterWatch`
 * (per-item, or the global `settings.auto_delete_after_watch` default) and
 * `settings.auto_delete_after_days` (age-based, independent of watched
 * status). A row only ever needs to satisfy one of the two conditions.
 */
export function getAutoDeleteCandidates(db: Database): AutoDeleteCandidate[] {
  return db
    .prepare(
      `SELECT d.id AS id, d.file_path_original AS filePathOriginal, d.file_path_web_ready AS filePathWebReady
       FROM download_items d, settings s
       WHERE d.status = 'ready'
         AND (
           (d.watched = 1 AND (d.auto_delete_after_watch = 1 OR s.auto_delete_after_watch = 1))
           OR (s.auto_delete_after_days IS NOT NULL AND d.completed_at IS NOT NULL
               AND julianday('now') - julianday(d.completed_at) >= s.auto_delete_after_days)
         )`,
    )
    .all() as AutoDeleteCandidate[];
}

/** Any row at all for this stremioId, regardless of quality/status — used by P10's auto-download to avoid re-triggering an episode that's already queued, downloading, ready, or even failed (a failed auto-enqueue shouldn't retry itself forever on every subsequent episode completion; the user can still retry it manually via PATCH). */
export function existsByStremioId(db: Database, stremioId: string): boolean {
  return db.prepare("SELECT 1 FROM download_items WHERE stremio_id = ? LIMIT 1").get(stremioId) !== undefined;
}

/** Idempotent by (stremio_id, quality) — the schema's UNIQUE constraint makes a duplicate enqueue a no-op. */
export function enqueueDownload(
  db: Database,
  item: {
    id: string;
    stremioId: string;
    seriesId: string | null;
    type: "movie" | "series";
    title: string;
    year: number | null;
    season: number | null;
    episode: number | null;
    quality: string;
    sourceKind: string;
    sourceUrl: string;
    storageTargetId: string;
  },
): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO download_items
         (id, stremio_id, series_id, type, title, year, season, episode, quality,
          source_kind, source_url, status, storage_target_id, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, datetime('now'))`,
    )
    .run(
      item.id,
      item.stremioId,
      item.seriesId,
      item.type,
      item.title,
      item.year,
      item.season,
      item.episode,
      item.quality,
      item.sourceKind,
      item.sourceUrl,
      item.storageTargetId,
    );
  return result.changes > 0;
}

export function markDownloading(db: Database, id: string): void {
  db.prepare(`UPDATE download_items SET status = 'downloading', last_error = NULL WHERE id = ?`).run(id);
}

export function updateProgress(
  db: Database,
  id: string,
  patch: { bytesDownloaded: number; bytesTotal: number | null; speedBps: number | null; etaSeconds: number | null },
): void {
  const progressPct = patch.bytesTotal ? Math.min(100, (patch.bytesDownloaded / patch.bytesTotal) * 100) : 0;
  db.prepare(
    `UPDATE download_items
     SET bytes_downloaded = ?, bytes_total = ?, speed_bps = ?, eta_seconds = ?, progress_pct = ?
     WHERE id = ?`,
  ).run(patch.bytesDownloaded, patch.bytesTotal, patch.speedBps, patch.etaSeconds, progressPct, id);
}

export function setEtag(db: Database, id: string, etag: string | null): void {
  db.prepare(`UPDATE download_items SET source_etag = ? WHERE id = ?`).run(etag, id);
}

// Rows the user has cancelled/deleted (P5) are a terminal, user-owned state
// — a job that was already in flight when the cancel happened must not be
// able to resurrect the row when it finishes late. Every completion-writing
// mutation below guards against that race with this clause.
const NOT_CANCELLED_OR_DELETED = `status NOT IN ('cancelled', 'deleted')`;

export function markQueued(db: Database, id: string): void {
  db.prepare(`UPDATE download_items SET status = 'queued' WHERE id = ? AND ${NOT_CANCELLED_OR_DELETED}`).run(id);
}

/** Network loss / disk-full: pause without spending retry budget — CLAUDE.md §4. */
export function markPaused(db: Database, id: string, reason: string): void {
  db.prepare(
    `UPDATE download_items SET status = 'paused', last_error = ?, retryable_error = 1
     WHERE id = ? AND ${NOT_CANCELLED_OR_DELETED}`,
  ).run(reason, id);
}

export function markFailed(db: Database, id: string, reason: string, retryable: boolean): void {
  db.prepare(
    `UPDATE download_items SET status = 'failed', last_error = ?, retryable_error = ?
     WHERE id = ? AND ${NOT_CANCELLED_OR_DELETED}`,
  ).run(reason, retryable ? 1 : 0, id);
}

export function incrementAttempt(db: Database, id: string): void {
  db.prepare(`UPDATE download_items SET attempt_count = attempt_count + 1 WHERE id = ?`).run(id);
}

/** Remux verified and published into the library — the file is now playable. */
export function markReady(db: Database, id: string, patch: { filePathWebReady: string }): void {
  db.prepare(
    `UPDATE download_items
     SET status = 'ready', file_path_web_ready = ?, completed_at = datetime('now'), last_error = NULL
     WHERE id = ? AND ${NOT_CANCELLED_OR_DELETED}`,
  ).run(patch.filePathWebReady, id);
}

/**
 * Records that a sidecar subtitle now exists for this language — CLAUDE.md
 * §3 Rule 9. The addon's `subtitles` resource trusts this column rather
 * than checking the filesystem itself (keeps the addon package DB-only,
 * consistent with the rest of its handlers). Idempotent: adding a language
 * that's already recorded is a no-op, not a duplicate.
 */
export function addSubtitleLang(db: Database, id: string, lang: string): void {
  const row = db.prepare("SELECT subtitle_langs AS value FROM download_items WHERE id = ?").get(id) as
    | { value: string }
    | undefined;
  if (!row) return;
  const langs = new Set(JSON.parse(row.value) as string[]);
  if (langs.has(lang)) return;
  langs.add(lang);
  db.prepare("UPDATE download_items SET subtitle_langs = ? WHERE id = ?").run(JSON.stringify([...langs]), id);
}

/** Download phase complete, raw file in place — awaiting the P4 remux stage. */
export function markAwaitingRemux(
  db: Database,
  id: string,
  patch: { filePathOriginal: string; bytesDownloaded: number; bytesTotal: number; sha256: string },
): void {
  db.prepare(
    `UPDATE download_items
     SET status = 'remuxing', file_path_original = ?, bytes_downloaded = ?, bytes_total = ?,
         sha256 = ?, progress_pct = 100, last_error = NULL
     WHERE id = ? AND ${NOT_CANCELLED_OR_DELETED}`,
  ).run(patch.filePathOriginal, patch.bytesDownloaded, patch.bytesTotal, patch.sha256, id);
}

/** User-initiated pause — CLAUDE.md §8 PATCH /downloads/:id. Only valid from a state where there's something to pause. */
export function pauseDownload(db: Database, id: string): "ok" | "not-found" | "invalid-state" {
  const row = getById(db, id);
  if (!row) return "not-found";
  if (row.status !== "queued" && row.status !== "downloading") return "invalid-state";
  db.prepare(`UPDATE download_items SET status = 'paused', last_error = NULL WHERE id = ?`).run(id);
  return "ok";
}

/** User-initiated resume of a paused row (distinct from the automatic network-loss resume in reconcile/scheduler). */
export function resumeDownload(db: Database, id: string): "ok" | "not-found" | "invalid-state" {
  const row = getById(db, id);
  if (!row) return "not-found";
  if (row.status !== "paused") return "invalid-state";
  db.prepare(`UPDATE download_items SET status = 'queued' WHERE id = ?`).run(id);
  return "ok";
}

/** Manual retry — CLAUDE.md §3 Rule 6 "Failed — select to retry". Resets the attempt budget since this is a fresh, user-initiated attempt, not another automatic retry. */
export function retryDownload(db: Database, id: string): "ok" | "not-found" | "invalid-state" {
  const row = getById(db, id);
  if (!row) return "not-found";
  if (row.status !== "failed") return "invalid-state";
  db.prepare(
    `UPDATE download_items
     SET status = 'queued', attempt_count = 0, last_error = NULL, retryable_error = 0
     WHERE id = ?`,
  ).run(id);
  return "ok";
}

export function setPriority(db: Database, id: string, priority: number): boolean {
  const result = db.prepare(`UPDATE download_items SET priority = ? WHERE id = ?`).run(priority, id);
  return result.changes > 0;
}

/**
 * Cancel/delete — CLAUDE.md §8 DELETE /downloads/:id. `ready` rows become
 * `deleted` (a finished download being removed); anything still in-flight
 * becomes `cancelled` (an in-progress job being stopped). Both are already
 * excluded from the addon's catalog/stream queries. Idempotent: deleting an
 * already-cancelled/deleted row is a no-op, not an error.
 */
export function cancelOrDeleteDownload(db: Database, id: string): { status: "cancelled" | "deleted" } | "not-found" | "already-gone" {
  const row = getById(db, id);
  if (!row) return "not-found";
  if (row.status === "cancelled" || row.status === "deleted") return "already-gone";

  const nextStatus = row.status === "ready" ? "deleted" : "cancelled";
  db.prepare(`UPDATE download_items SET status = ? WHERE id = ?`).run(nextStatus, id);
  return { status: nextStatus };
}
