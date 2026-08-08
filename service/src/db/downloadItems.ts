import type { Database } from "better-sqlite3";

export interface QueueRow {
  id: string;
  stremioId: string;
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
  id, stremio_id AS stremioId, quality, source_kind AS sourceKind, source_url AS sourceUrl,
  source_etag AS sourceEtag, status, bytes_downloaded AS bytesDownloaded, bytes_total AS bytesTotal,
  storage_target_id AS storageTargetId, file_path_original AS filePathOriginal,
  attempt_count AS attemptCount, priority, added_at AS addedAt
`;

export function getById(db: Database, id: string): QueueRow | undefined {
  return db.prepare(`SELECT ${ROW_COLUMNS} FROM download_items WHERE id = ?`).get(id) as QueueRow | undefined;
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
): void {
  db.prepare(
    `INSERT OR IGNORE INTO download_items
       (id, stremio_id, series_id, type, title, year, season, episode, quality,
        source_kind, source_url, status, storage_target_id, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, datetime('now'))`,
  ).run(
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

export function markQueued(db: Database, id: string): void {
  db.prepare(`UPDATE download_items SET status = 'queued' WHERE id = ?`).run(id);
}

/** Network loss / disk-full: pause without spending retry budget — CLAUDE.md §4. */
export function markPaused(db: Database, id: string, reason: string): void {
  db.prepare(`UPDATE download_items SET status = 'paused', last_error = ?, retryable_error = 1 WHERE id = ?`).run(
    reason,
    id,
  );
}

export function markFailed(db: Database, id: string, reason: string, retryable: boolean): void {
  db.prepare(
    `UPDATE download_items SET status = 'failed', last_error = ?, retryable_error = ? WHERE id = ?`,
  ).run(reason, retryable ? 1 : 0, id);
}

export function incrementAttempt(db: Database, id: string): void {
  db.prepare(`UPDATE download_items SET attempt_count = attempt_count + 1 WHERE id = ?`).run(id);
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
     WHERE id = ?`,
  ).run(patch.filePathOriginal, patch.bytesDownloaded, patch.bytesTotal, patch.sha256, id);
}
