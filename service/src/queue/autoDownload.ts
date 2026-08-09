import { randomUUID } from "node:crypto";
import type { Quality, SourceAddon } from "@stremio-offline/shared";
import type { Database } from "better-sqlite3";
import { enqueueDownload, existsByStremioId } from "../db/downloadItems.js";
import { getSettings } from "../db/settings.js";
import { listSourceAddons } from "../db/sourceAddons.js";
import { recordError } from "../observability/errorLog.js";
import { fetchSeriesVideos, fetchStreamsFromAddon, resolveStreamSource, type ResolvedSource } from "../resolvers/addonClient.js";
import { getConfiguredResolver } from "../resolvers/autodetect.js";

export interface AutoDownloadRow {
  id: string;
  stremioId: string;
  seriesId: string | null;
  type: "movie" | "series";
  title: string;
  season: number | null;
  episode: number | null;
}

interface EpisodeTarget {
  stremioId: string;
  season: number;
  episode: number;
  title: string;
}

function parseStremioId(stremioId: string): { imdbId: string; season: number | null; episode: number | null } {
  const [imdbId, seasonStr, episodeStr] = stremioId.split(":");
  return {
    imdbId: imdbId ?? stremioId,
    season: seasonStr ? Number(seasonStr) : null,
    episode: episodeStr ? Number(episodeStr) : null,
  };
}

/**
 * Finds the next `lookahead` episodes after `row`, preferring a registered
 * addon's real episode list (correctly crosses season boundaries) and
 * falling back to a naive same-season increment when none of the
 * registered addons implement the `meta` resource for this series — many
 * stream-only addons (Torrentio and similar) don't. CLAUDE.md §1: "auto-
 * download the next episode while binge-watching" is one of the four named
 * complaints this project exists to fix.
 */
async function findNextEpisodeTargets(
  addons: SourceAddon[],
  row: AutoDownloadRow,
  lookahead: number,
  fetchImpl: typeof fetch,
): Promise<EpisodeTarget[]> {
  const { imdbId, season, episode } = parseStremioId(row.stremioId);
  if (season === null || episode === null) return [];

  for (const addon of addons) {
    const videos = await fetchSeriesVideos(addon.manifestUrl, imdbId, fetchImpl);
    if (!videos || videos.length === 0) continue;

    const sorted = videos
      .filter((v): v is typeof v & { season: number; episode: number } => typeof v.season === "number" && typeof v.episode === "number")
      .sort((a, b) => a.season - b.season || a.episode - b.episode);
    const currentIndex = sorted.findIndex((v) => v.season === season && v.episode === episode);
    if (currentIndex === -1) continue;

    return sorted.slice(currentIndex + 1, currentIndex + 1 + lookahead).map((v) => ({
      stremioId: v.id,
      season: v.season,
      episode: v.episode,
      title: v.title && v.title.length > 0 ? v.title : `${row.title} S${v.season}E${v.episode}`,
    }));
  }

  // No registered addon exposes a real episode list — same-season-only
  // fallback. A season boundary is only crossed correctly once an addon
  // with `meta` support is registered; documented in PROGRESS.md.
  const targets: EpisodeTarget[] = [];
  for (let i = 1; i <= lookahead; i++) {
    const nextEpisode = episode + i;
    targets.push({
      stremioId: `${imdbId}:${season}:${nextEpisode}`,
      season,
      episode: nextEpisode,
      title: `${row.title} S${season}E${nextEpisode}`,
    });
  }
  return targets;
}

/** Prefers an exact match on the user's default quality; falls back to a stream whose quality couldn't be determined from its title rather than skipping the episode entirely. Returns null if this addon has nothing usable. */
function pickStream(streams: ResolvedSource[], defaultQuality: Quality): ResolvedSource | null {
  return streams.find((s) => s.quality === defaultQuality) ?? streams.find((s) => s.quality === "original") ?? null;
}

export interface AutoDownloadDeps {
  db: Database;
  storageRoot: string;
  fetchImpl?: typeof fetch;
  installIdHash?: string;
}

/**
 * Best-effort — called right after an episode's remux publishes. Never
 * affects the episode that just completed: any failure here is recorded
 * for the weekly rollup and otherwise swallowed, same pattern as P7's
 * fetchSubtitlesBestEffort in remuxRunner.ts.
 */
export async function triggerAutoDownloadNextEpisodes(deps: AutoDownloadDeps, row: AutoDownloadRow): Promise<void> {
  if (row.type !== "series" || row.season === null || row.episode === null) return;

  const fetchImpl = deps.fetchImpl ?? fetch;

  try {
    const settings = getSettings(deps.db);
    if (!settings.autoDownloadNextEpisode) return;

    const addons = listSourceAddons(deps.db);
    if (addons.length === 0) return;

    const targets = await findNextEpisodeTargets(addons, row, Math.max(1, settings.autoDownloadLookahead), fetchImpl);
    if (targets.length === 0) return;

    const configuredResolver = getConfiguredResolver(deps.db);

    for (const target of targets) {
      // Idempotency: CLAUDE.md §4 — never create a second job for a title
      // already enqueued/downloaded/failed. A previously-failed auto-enqueue
      // is left to a manual retry rather than being re-attempted on every
      // subsequent episode completion.
      if (existsByStremioId(deps.db, target.stremioId)) continue;

      let picked: ResolvedSource | null = null;
      for (const addon of addons) {
        const streams = await fetchStreamsFromAddon(addon.manifestUrl, "series", target.stremioId, fetchImpl);
        const resolved = streams.map(resolveStreamSource).filter((s): s is ResolvedSource => s !== null);
        picked = pickStream(resolved, settings.defaultQuality);
        if (picked) break;
      }
      if (!picked) continue; // no registered addon has a usable stream yet — not a failure, just nothing to do

      const sourceKind = picked.sourceKind === "magnet" && configuredResolver ? "debrid" : picked.sourceKind;

      enqueueDownload(deps.db, {
        id: randomUUID(),
        stremioId: target.stremioId,
        seriesId: row.seriesId ?? parseStremioId(row.stremioId).imdbId,
        type: "series",
        title: target.title,
        year: null,
        season: target.season,
        episode: target.episode,
        quality: picked.quality,
        sourceKind,
        sourceUrl: picked.sourceUrl,
        storageTargetId: settings.defaultStorageTargetId,
      });
    }
  } catch (err) {
    recordError(deps.storageRoot, "autoDownload", err, { installIdHash: deps.installIdHash ?? "unknown" });
  }
}
