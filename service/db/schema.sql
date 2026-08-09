-- SQLite schema. WAL mode + synchronous=NORMAL are set by db/client.ts at connection time,
-- not here, since PRAGMAs are per-connection.

CREATE TABLE IF NOT EXISTS download_items (
  id                    TEXT PRIMARY KEY,
  stremio_id            TEXT NOT NULL,
  series_id             TEXT,
  type                  TEXT NOT NULL CHECK (type IN ('movie', 'series')),
  title                 TEXT NOT NULL,
  year                  INTEGER,
  season                INTEGER,
  episode               INTEGER,
  quality               TEXT NOT NULL CHECK (quality IN ('480p','720p','1080p','1440p','4k','original')),
  source_kind           TEXT NOT NULL CHECK (source_kind IN ('http','magnet','debrid')),
  source_url            TEXT NOT NULL,
  source_etag           TEXT,
  status                TEXT NOT NULL CHECK (status IN
                           ('queued','resolving','downloading','paused','remuxing',
                            'verifying','ready','failed','cancelled','deleted')),
  progress_pct          REAL NOT NULL DEFAULT 0,
  bytes_downloaded      INTEGER NOT NULL DEFAULT 0,
  bytes_total           INTEGER,
  speed_bps             REAL,
  eta_seconds           INTEGER,
  storage_target_id     TEXT NOT NULL,
  file_path_original    TEXT,
  file_path_web_ready   TEXT,
  sha256                TEXT,
  video_hash            TEXT,
  video_size            INTEGER,
  subtitle_langs        TEXT NOT NULL DEFAULT '[]', -- JSON array
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT,
  retryable_error       INTEGER NOT NULL DEFAULT 0,
  watched               INTEGER NOT NULL DEFAULT 0,
  last_position_seconds INTEGER NOT NULL DEFAULT 0,
  last_watched_at       TEXT,
  auto_delete_after_watch INTEGER NOT NULL DEFAULT 0,
  priority              INTEGER NOT NULL DEFAULT 0,
  added_at              TEXT NOT NULL,
  completed_at          TEXT,
  UNIQUE (stremio_id, quality)
);

CREATE INDEX IF NOT EXISTS idx_download_items_status ON download_items(status);
CREATE INDEX IF NOT EXISTS idx_download_items_series ON download_items(series_id);

CREATE TABLE IF NOT EXISTS storage_targets (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  path         TEXT NOT NULL,
  is_removable INTEGER NOT NULL DEFAULT 0,
  is_default   INTEGER NOT NULL DEFAULT 0,
  bytes_free   INTEGER NOT NULL DEFAULT 0,
  bytes_total  INTEGER NOT NULL DEFAULT 0,
  writable     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS settings (
  id                        INTEGER PRIMARY KEY CHECK (id = 1),
  wifi_only                 INTEGER NOT NULL DEFAULT 0,
  default_quality           TEXT NOT NULL DEFAULT '1080p',
  auto_download_next_episode INTEGER NOT NULL DEFAULT 0,
  auto_download_lookahead   INTEGER NOT NULL DEFAULT 1,
  auto_delete_after_watch   INTEGER NOT NULL DEFAULT 0,
  auto_delete_after_days    INTEGER,
  max_concurrent_downloads  INTEGER NOT NULL DEFAULT 2,
  max_concurrent_remuxes    INTEGER NOT NULL DEFAULT 1,
  default_storage_target_id TEXT,
  subtitle_langs            TEXT NOT NULL DEFAULT '["en"]', -- JSON array
  open_subtitles_api_key    TEXT,
  public_base_url           TEXT,
  legal_notice_accepted_at  TEXT
);

INSERT OR IGNORE INTO settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS source_addons (
  id            TEXT PRIMARY KEY,
  manifest_url  TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  added_at      TEXT NOT NULL
);

-- One row per debrid service the user has configured — CLAUDE.md §3 Rule 7.
-- `service` is the primary key: only one account per service, matching
-- autodetect.ts's "which services are configured" query.
CREATE TABLE IF NOT EXISTS debrid_accounts (
  service  TEXT PRIMARY KEY CHECK (service IN ('realdebrid','alldebrid','premiumize','debridlink','torbox')),
  api_key  TEXT NOT NULL,
  enabled  INTEGER NOT NULL DEFAULT 1,
  added_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('version', '1');
