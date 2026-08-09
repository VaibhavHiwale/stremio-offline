// Single source of truth for cross-package types. No runtime deps.
// Update this file first whenever a phase needs a new field, then propagate.

export type Quality = "480p" | "720p" | "1080p" | "1440p" | "4k" | "original";

export type DownloadStatus =
  | "queued"
  | "resolving"
  | "downloading"
  | "paused"
  | "remuxing"
  | "verifying"
  | "ready"
  | "failed"
  | "cancelled"
  | "deleted";

export type SourceKind = "http" | "magnet" | "debrid";

// --- Debrid (P6) ------------------------------------------------------------

export type DebridService = "realdebrid" | "alldebrid" | "premiumize" | "debridlink" | "torbox";

/** One row per service the user has configured — CLAUDE.md §3 Rule 7. */
export interface DebridAccount {
  service: DebridService;
  apiKey: string;
  enabled: boolean;
  addedAt: string;
}

export type ContentType = "movie" | "series";

export interface DownloadItem {
  id: string;
  stremioId: string; // "tt0903747:1:1"
  seriesId: string | null; // for grouping
  type: ContentType;
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  quality: Quality;
  sourceKind: SourceKind;
  sourceUrl: string;
  sourceEtag: string | null;
  status: DownloadStatus;
  progressPct: number;
  bytesDownloaded: number;
  bytesTotal: number | null;
  speedBps: number | null;
  etaSeconds: number | null;
  storageTargetId: string;
  filePathOriginal: string | null;
  filePathWebReady: string | null;
  sha256: string | null;
  subtitleLangs: string[];
  attemptCount: number;
  lastError: string | null;
  retryableError: boolean;
  watched: boolean;
  lastPositionSeconds: number;
  lastWatchedAt: string | null;
  autoDeleteAfterWatch: boolean;
  priority: number;
  addedAt: string;
  completedAt: string | null;
}

export interface StorageTarget {
  id: string;
  label: string;
  path: string;
  isRemovable: boolean;
  isDefault: boolean;
  bytesFree: number;
  bytesTotal: number;
  writable: boolean;
}

export interface Settings {
  wifiOnly: boolean;
  defaultQuality: Quality;
  autoDownloadNextEpisode: boolean;
  autoDownloadLookahead: number;
  autoDeleteAfterWatch: boolean;
  autoDeleteAfterDays: number | null;
  maxConcurrentDownloads: number;
  maxConcurrentRemuxes: number;
  defaultStorageTargetId: string;
  subtitleLangs: string[];
  publicBaseUrl: string | null;
  legalNoticeAcceptedAt: string | null;
}

// --- Health / diagnostics --------------------------------------------------

export type SubsystemStatus = "ok" | "degraded" | "down";

export interface HealthReport {
  status: SubsystemStatus;
  timestamp: string;
  subsystems: {
    db: SubsystemStatus;
    disk: SubsystemStatus;
    diskFreeBytes: number | null;
    cert: SubsystemStatus;
    certExpiresAt: string | null;
    activeJobs: number;
    ffmpeg: SubsystemStatus;
    debrid: SubsystemStatus;
  };
}
