import type { Database } from "better-sqlite3";

export interface DownloadItemRow {
  id: string;
  stremioId: string;
  seriesId: string | null;
  type: "movie" | "series";
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  quality: string;
  status: string;
  progressPct: number;
  bytesDownloaded: number;
  bytesTotal: number | null;
  speedBps: number | null;
  etaSeconds: number | null;
  filePathWebReady: string | null;
  priority: number;
  addedAt: string;
}

const ROW_COLUMNS = `
  id, stremio_id AS stremioId, series_id AS seriesId, type, title, year, season, episode,
  quality, status, progress_pct AS progressPct, bytes_downloaded AS bytesDownloaded,
  bytes_total AS bytesTotal, speed_bps AS speedBps, eta_seconds AS etaSeconds,
  file_path_web_ready AS filePathWebReady, priority, added_at AS addedAt
`;

const VISIBLE_STATUSES = "status NOT IN ('cancelled', 'deleted')";

export interface CatalogQuery {
  type: "movie" | "series";
  search: string | null;
  skip: number;
  limit: number;
}

export interface CatalogEntry {
  id: string; // stremioId for movies, seriesId for series
  title: string;
  year: number | null;
}

/** One row per title (movies) or per show (series) — GROUP BY picks an arbitrary representative row per group, which is fine since title/year don't vary across quality/episode rows for the same title. */
export function queryCatalog(db: Database, q: CatalogQuery): CatalogEntry[] {
  const groupCol = q.type === "movie" ? "stremio_id" : "series_id";
  const searchClause = q.search ? "AND title LIKE ?" : "";
  const params: (string | number)[] = [q.type];
  if (q.search) params.push(`%${q.search}%`);
  params.push(q.limit, q.skip);

  const rows = db
    .prepare(
      `SELECT ${groupCol} AS id, title, year
       FROM download_items
       WHERE type = ? AND ${VISIBLE_STATUSES} AND ${groupCol} IS NOT NULL ${searchClause}
       GROUP BY ${groupCol}
       ORDER BY MAX(added_at) DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params) as CatalogEntry[];

  return rows;
}

export function queryByStremioId(db: Database, stremioId: string): DownloadItemRow[] {
  return db
    .prepare(`SELECT ${ROW_COLUMNS} FROM download_items WHERE stremio_id = ? AND ${VISIBLE_STATUSES}`)
    .all(stremioId) as DownloadItemRow[];
}

export function queryBySeriesId(db: Database, seriesId: string): DownloadItemRow[] {
  return db
    .prepare(
      `SELECT ${ROW_COLUMNS} FROM download_items
       WHERE series_id = ? AND ${VISIBLE_STATUSES}
       ORDER BY season ASC, episode ASC`,
    )
    .all(seriesId) as DownloadItemRow[];
}

/** Position in the queue, 1-indexed, ordered the same way the (future) scheduler will drain it. */
export function queuePosition(db: Database, row: DownloadItemRow): number {
  const result = db
    .prepare(
      `SELECT COUNT(*) AS n FROM download_items
       WHERE status = 'queued' AND (priority > ? OR (priority = ? AND added_at <= ?))`,
    )
    .get(row.priority, row.priority, row.addedAt) as { n: number };
  return result.n;
}
