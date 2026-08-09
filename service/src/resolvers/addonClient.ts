import type { Quality } from "@stremio-offline/shared";

/**
 * CLAUDE.md §10 P10: "addonClient.ts queries registered source addons
 * server-side for the next N episodes." A registered source addon is any
 * ordinary Stremio addon (Torrentio, a public-domain catalog, etc.) — this
 * module speaks the same plain-JSON protocol `addon/` implements, just as a
 * client instead of a server. Deliberately not sharing types with
 * `@stremio-offline/addon`'s `protocol.ts`: that module describes what
 * *this* addon emits (playback URLs only); an arbitrary third-party addon's
 * stream objects can carry `infoHash`/`fileIdx`/`sources` for torrents,
 * which this app's own protocol types never need to express.
 */

export interface ExternalStream {
  name?: string;
  title?: string;
  url?: string;
  infoHash?: string;
  sources?: string[]; // "tracker:udp://...", "dht:...", etc.
}

export interface ExternalVideo {
  id: string; // "tt0903747:1:2"
  season?: number;
  episode?: number;
  title?: string;
}

function addonBaseUrl(manifestUrl: string): string {
  return manifestUrl.replace(/\/manifest\.json$/, "");
}

export interface AddonManifestInfo {
  name: string;
  resources: string[];
}

/** Fetches and lightly validates a manifest — used by POST /addons to derive a display name and reject non-addon or stream-less URLs before registering them. */
export async function fetchAddonManifestInfo(manifestUrl: string, fetchImpl: typeof fetch = fetch): Promise<AddonManifestInfo> {
  const res = await fetchImpl(manifestUrl);
  if (!res.ok) throw new Error(`manifest fetch failed: HTTP ${res.status}`);
  const body = (await res.json()) as { name?: string; resources?: (string | { name: string })[] };
  const resources = (body.resources ?? []).map((r) => (typeof r === "string" ? r : r.name));
  if (!resources.includes("stream")) throw new Error("manifest does not declare the 'stream' resource");
  return { name: body.name && body.name.length > 0 ? body.name : manifestUrl, resources };
}

/** Never throws — a single unreachable/misbehaving addon must not block the others being queried for the same episode. */
export async function fetchStreamsFromAddon(
  manifestUrl: string,
  type: string,
  stremioId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExternalStream[]> {
  const url = `${addonBaseUrl(manifestUrl)}/stream/${type}/${encodeURIComponent(stremioId)}.json`;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return [];
    const body = (await res.json()) as { streams?: ExternalStream[] };
    return body.streams ?? [];
  } catch {
    return [];
  }
}

/** Returns null (not an empty array) when this addon doesn't implement `meta` for the series, or the lookup fails — the caller uses null to mean "try the next addon", and [] to mean "this addon has no episodes listed". */
export async function fetchSeriesVideos(manifestUrl: string, imdbId: string, fetchImpl: typeof fetch = fetch): Promise<ExternalVideo[] | null> {
  const url = `${addonBaseUrl(manifestUrl)}/meta/series/${encodeURIComponent(imdbId)}.json`;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const body = (await res.json()) as { meta?: { videos?: ExternalVideo[] } };
    return body.meta?.videos ?? null;
  } catch {
    return null;
  }
}

const QUALITY_PATTERNS: [RegExp, Quality][] = [
  [/\b(2160p|4k|uhd)\b/i, "4k"],
  [/\b1440p\b/i, "1440p"],
  [/\b1080p\b/i, "1080p"],
  [/\b720p\b/i, "720p"],
  [/\b480p\b/i, "480p"],
];

/** Falls back to "original" (meaning "unknown", not literally the source master) when a stream's name/title carries no recognizable quality tag — common for public-domain or single-quality addons. */
export function guessQuality(text: string): Quality {
  for (const [pattern, quality] of QUALITY_PATTERNS) {
    if (pattern.test(text)) return quality;
  }
  return "original";
}

export interface ResolvedSource {
  sourceKind: "http" | "magnet";
  sourceUrl: string;
  quality: Quality;
}

/**
 * Converts one external stream entry into something `enqueueDownload` can
 * use. `sourceKind` here is only ever "http" or "magnet" — whether a magnet
 * should actually be enqueued as `sourceKind: "magnet"` (webtorrent) or
 * `"debrid"` (CLAUDE.md §3 Rule 7's preferred path) depends on whether the
 * user has a debrid account configured, which this module has no reason to
 * know about — that decision belongs to the caller (queue/autoDownload.ts).
 * Returns null for stream shapes this can't act on (no url, no infoHash —
 * e.g. a "please upgrade" placeholder stream some addons return).
 */
export function resolveStreamSource(stream: ExternalStream): ResolvedSource | null {
  const quality = guessQuality(`${stream.name ?? ""} ${stream.title ?? ""}`);

  if (stream.url) {
    if (stream.url.startsWith("magnet:")) return { sourceKind: "magnet", sourceUrl: stream.url, quality };
    if (stream.url.startsWith("http://") || stream.url.startsWith("https://")) {
      return { sourceKind: "http", sourceUrl: stream.url, quality };
    }
    return null;
  }

  if (stream.infoHash) {
    const trackers = (stream.sources ?? [])
      .filter((s) => s.startsWith("tracker:"))
      .map((s) => `&tr=${encodeURIComponent(s.slice("tracker:".length))}`)
      .join("");
    const dn = stream.title ? `&dn=${encodeURIComponent(stream.title)}` : "";
    return { sourceKind: "magnet", sourceUrl: `magnet:?xt=urn:btih:${stream.infoHash}${dn}${trackers}`, quality };
  }

  return null;
}
