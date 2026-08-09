import type { DebridResolver, ResolveOutcome } from "./types.js";
import { classifyHttpStatusError } from "./types.js";

const BASE = "https://api.real-debrid.com/rest/1.0";

interface TorrentInfo {
  status: string;
  files: { id: number; path: string; bytes: number; selected: number }[];
  links: string[];
}

async function addMagnet(
  apiKey: string,
  magnetUri: string,
  doFetch: typeof fetch,
): Promise<{ id: string } | { error: string }> {
  const res = await doFetch(`${BASE}/torrents/addMagnet`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ magnet: magnetUri }),
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return (await res.json()) as { id: string };
}

async function getInfo(apiKey: string, id: string, doFetch: typeof fetch): Promise<TorrentInfo | { error: string }> {
  const res = await doFetch(`${BASE}/torrents/info/${id}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return (await res.json()) as TorrentInfo;
}

async function selectFiles(apiKey: string, id: string, doFetch: typeof fetch): Promise<void> {
  await doFetch(`${BASE}/torrents/selectFiles/${id}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ files: "all" }),
  });
}

async function unrestrict(
  apiKey: string,
  link: string,
  doFetch: typeof fetch,
): Promise<{ download: string } | { error: string }> {
  const res = await doFetch(`${BASE}/unrestrict/link`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ link }),
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return (await res.json()) as { download: string };
}

const TERMINAL_STATUSES = new Set(["magnet_error", "error", "virus", "dead"]);

/**
 * Real-Debrid (api.real-debrid.com/rest/1.0) — CLAUDE.md §3 Rule 7.
 * Contract reconstructed from Real-Debrid's public API docs; **not verified
 * against a live account** — see PROGRESS.md's P6 notes before relying on
 * this in production. Flow: addMagnet → (if `waiting_files_selection`)
 * selectFiles("all") → re-check for the cached torrent's Real-Debrid-hosted
 * links → unrestrict/link for the actual direct HTTPS URL. Re-adding an
 * already-known magnet is assumed idempotent (Real-Debrid returns the
 * existing torrent rather than erroring), matching how other Stremio debrid
 * integrations use this API — untested here.
 */
export const realDebridResolver: DebridResolver = {
  service: "realdebrid",

  async resolveMagnet(apiKey, magnetUri, fetchImpl = fetch): Promise<ResolveOutcome> {
    const added = await addMagnet(apiKey, magnetUri, fetchImpl);
    if ("error" in added) return classifyHttpStatusError(added.error);

    let info = await getInfo(apiKey, added.id, fetchImpl);
    if ("error" in info) return classifyHttpStatusError(info.error);

    if (info.status === "waiting_files_selection") {
      await selectFiles(apiKey, added.id, fetchImpl);
      info = await getInfo(apiKey, added.id, fetchImpl);
      if ("error" in info) return classifyHttpStatusError(info.error);
    }

    if (TERMINAL_STATUSES.has(info.status)) {
      return { status: "error", message: `Real-Debrid reported status '${info.status}'`, retryable: false };
    }

    if (info.status !== "downloaded" || info.links.length === 0) {
      return { status: "pending", message: `Real-Debrid is still caching this torrent (status: ${info.status})` };
    }

    const unrestricted = await unrestrict(apiKey, info.links[0]!, fetchImpl);
    if ("error" in unrestricted) return classifyHttpStatusError(unrestricted.error);
    return { status: "ready", directUrl: unrestricted.download };
  },
};
