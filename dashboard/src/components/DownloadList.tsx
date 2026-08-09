import type { DownloadItem } from "@stremio-offline/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useProgressSocket } from "../useProgressSocket";
import { DownloadCard } from "./DownloadCard";

const REFRESH_INTERVAL_MS = 5000;

export function DownloadList(): React.JSX.Element {
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { activeItems, connectionState } = useProgressSocket();

  const refresh = useCallback(async () => {
    try {
      const { items: fetched } = await api.listDownloads();
      setItems(fetched);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  // Live-merge WS snapshots (in-flight items only) over the REST-fetched
  // list so progress updates land immediately instead of waiting out
  // REFRESH_INTERVAL_MS — terminal items (ready/failed/...) still come from
  // the periodic REST refetch, since the WS snapshot never includes them.
  useEffect(() => {
    if (activeItems.length === 0) return;
    setItems((prev) => {
      const byId = new Map(prev.map((item) => [item.id, item]));
      for (const active of activeItems) byId.set(active.id, active);
      return [...byId.values()];
    });
  }, [activeItems]);

  const handleAction = useCallback(
    async (id: string, action: "pause" | "resume" | "retry" | "delete") => {
      try {
        if (action === "delete") await api.deleteDownload(id);
        else if (action === "pause") await api.pauseDownload(id);
        else if (action === "resume") await api.resumeDownload(id);
        else await api.retryDownload(id);
      } finally {
        void refresh();
      }
    },
    [refresh],
  );

  const sorted = [...items].sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime());

  return (
    <div>
      <div className="connection-indicator">
        <span className={`connection-dot connection-dot--${connectionState}`} />
        {connectionState === "open" ? "Live" : connectionState === "connecting" ? "Connecting…" : "Reconnecting…"}
      </div>
      {loadError && <p className="error-banner">{loadError}</p>}
      {sorted.length === 0 ? (
        <p className="empty-state">No downloads yet.</p>
      ) : (
        <div className="download-list">
          {sorted.map((item) => (
            <DownloadCard key={item.id} item={item} onAction={handleAction} />
          ))}
        </div>
      )}
    </div>
  );
}
