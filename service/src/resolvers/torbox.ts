import type { DebridResolver, ResolveOutcome } from "./types.js";
import { errorOutcome } from "./types.js";

const BASE = "https://api.torbox.app/v1/api";

interface CreateTorrentResponse {
  success: boolean;
  detail?: string;
  data?: { torrent_id: number };
}

interface TorrentListItem {
  id: number;
  download_finished: boolean;
  files: { id: number; short_name: string; size: number }[];
}

interface TorrentListResponse {
  success: boolean;
  data?: TorrentListItem[];
}

interface RequestDlResponse {
  success: boolean;
  detail?: string;
  data?: string; // direct download URL
}

/**
 * TorBox (api.torbox.app/v1/api) — CLAUDE.md §3 Rule 7. Contract
 * reconstructed from TorBox's public API docs; **not verified against a
 * live account** — see PROGRESS.md's P6 notes. Flow: createtorrent →
 * mylist (to find the matching torrent and, once cached, its files) →
 * requestdl for the direct HTTPS URL of the largest file.
 */
export const torBoxResolver: DebridResolver = {
  service: "torbox",

  async resolveMagnet(apiKey, magnetUri, fetchImpl = fetch): Promise<ResolveOutcome> {
    const createRes = await fetchImpl(`${BASE}/torrents/createtorrent`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ magnet: magnetUri }),
    });
    if (!createRes.ok) {
      return { status: "error", message: `HTTP ${createRes.status}`, retryable: createRes.status === 429 || createRes.status >= 500 };
    }
    const created = (await createRes.json()) as CreateTorrentResponse;
    if (!created.success || created.data === undefined) return errorOutcome(created.detail ?? "TorBox createtorrent failed");

    const listRes = await fetchImpl(`${BASE}/torrents/mylist?id=${created.data.torrent_id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!listRes.ok) return { status: "error", message: `HTTP ${listRes.status}`, retryable: listRes.status >= 500 };
    const list = (await listRes.json()) as TorrentListResponse;
    const torrent = list.data?.find((t) => t.id === created.data!.torrent_id);

    if (!torrent || !torrent.download_finished || torrent.files.length === 0) {
      return { status: "pending", message: "TorBox is still caching this torrent" };
    }

    const largest = [...torrent.files].sort((a, b) => b.size - a.size)[0]!;
    const dlUrl = `${BASE}/torrents/requestdl?token=${encodeURIComponent(apiKey)}&torrent_id=${torrent.id}&file_id=${largest.id}`;
    const dlRes = await fetchImpl(dlUrl);
    if (!dlRes.ok) return { status: "error", message: `HTTP ${dlRes.status}`, retryable: dlRes.status >= 500 };
    const dl = (await dlRes.json()) as RequestDlResponse;
    if (!dl.success || !dl.data) return errorOutcome(dl.detail ?? "TorBox requestdl failed");

    return { status: "ready", directUrl: dl.data };
  },
};
