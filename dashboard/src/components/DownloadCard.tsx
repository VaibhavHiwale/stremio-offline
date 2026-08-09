import type { DownloadItem } from "@stremio-offline/shared";

const STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  resolving: "Resolving…",
  downloading: "Downloading",
  paused: "Paused",
  remuxing: "Preparing",
  verifying: "Verifying",
  ready: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
  deleted: "Deleted",
};

function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

function formatSpeed(bps: number | null): string {
  if (!bps) return "";
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

export function DownloadCard({
  item,
  onAction,
}: {
  item: DownloadItem;
  onAction: (id: string, action: "pause" | "resume" | "retry" | "delete") => void;
}): React.JSX.Element {
  const showProgressBar = item.status === "downloading" || item.status === "remuxing" || item.status === "verifying";

  return (
    <div className={`download-card status-${item.status}`}>
      <div className="download-card__main">
        <div className="download-card__title">
          {item.title}
          {item.season != null && item.episode != null ? ` S${item.season}E${item.episode}` : ""}
          <span className="download-card__quality">{item.quality}</span>
        </div>
        <div className="download-card__meta">
          <span className={`status-badge status-badge--${item.status}`}>{STATUS_LABELS[item.status] ?? item.status}</span>
          {item.status === "downloading" && (
            <span>
              {item.progressPct.toFixed(0)}% · {formatSpeed(item.speedBps)} · {formatBytes(item.bytesDownloaded)} /{" "}
              {formatBytes(item.bytesTotal)}
            </span>
          )}
          {item.status === "failed" && item.lastError && <span className="download-card__error">{item.lastError}</span>}
        </div>
        {showProgressBar && (
          <div className="progress-bar">
            <div className="progress-bar__fill" style={{ width: `${Math.max(2, item.progressPct)}%` }} />
          </div>
        )}
      </div>
      <div className="download-card__actions">
        {(item.status === "queued" || item.status === "downloading") && (
          <button onClick={() => onAction(item.id, "pause")}>Pause</button>
        )}
        {item.status === "paused" && <button onClick={() => onAction(item.id, "resume")}>Resume</button>}
        {item.status === "failed" && <button onClick={() => onAction(item.id, "retry")}>Retry</button>}
        {item.status !== "cancelled" && item.status !== "deleted" && (
          <button className="button--danger" onClick={() => onAction(item.id, "delete")}>
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
