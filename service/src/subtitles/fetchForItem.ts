import { downloadSubtitle, searchSubtitle } from "./opensubtitles.js";
import { sidecarPath, writeSidecar } from "./sidecar.js";

const LANG_CODE_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

/** "tt0903747:1:2" → "0903747" — OpenSubtitles wants the numeric imdb_id without the "tt" prefix. Null for anything that doesn't look like an IMDb id. */
export function parseImdbId(stremioId: string): string | null {
  const base = stremioId.split(":")[0] ?? "";
  const match = /^tt(\d+)$/.exec(base);
  return match?.[1] ?? null;
}

export interface FetchSubtitlesDeps {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface FetchSubtitlesResult {
  lang: string;
  path: string;
}

/**
 * Best-effort per-language subtitle fetch for one completed download —
 * CLAUDE.md §3 Rule 9 + §5. Deliberately never throws: a missing
 * translation, an exhausted quota, or a network blip for one language must
 * not affect the others, and must never affect the download's own
 * `ready` status — the video is already playable without it.
 */
export async function fetchSubtitlesForItem(
  videoPath: string,
  stremioId: string,
  langs: string[],
  deps: FetchSubtitlesDeps,
): Promise<FetchSubtitlesResult[]> {
  const imdbId = parseImdbId(stremioId);
  if (!imdbId) return [];

  const results: FetchSubtitlesResult[] = [];
  for (const lang of langs) {
    if (!LANG_CODE_RE.test(lang)) continue;
    try {
      const found = await searchSubtitle(deps.apiKey, imdbId, lang, deps.baseUrl, deps.fetchImpl);
      if (found.status !== "found") continue;

      const downloaded = await downloadSubtitle(deps.apiKey, found.fileId, deps.baseUrl, deps.fetchImpl);
      if (downloaded.status !== "ok") continue;

      const path = sidecarPath(videoPath, lang);
      await writeSidecar(path, downloaded.content);
      results.push({ lang, path });
    } catch {
      // Best-effort, per language — see the docstring above.
    }
  }
  return results;
}
