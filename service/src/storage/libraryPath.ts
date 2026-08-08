import { join } from "node:path";

// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;

export function sanitizeFilename(name: string): string {
  return name.replace(ILLEGAL_CHARS, "").trim().replace(/\s+/g, " ");
}

export interface LibraryItem {
  type: "movie" | "series";
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
}

/** Matches the official local-files addon's conventions — CLAUDE.md §7. */
export function computeLibraryPath(storageRoot: string, item: LibraryItem): string {
  const safeTitle = sanitizeFilename(item.title);

  if (item.type === "movie") {
    const label = item.year ? `${safeTitle} (${item.year})` : safeTitle;
    return join(storageRoot, "Movies", label, `${label}.mp4`);
  }

  const season = item.season ?? 1;
  const episode = item.episode ?? 1;
  const episodeLabel = `${safeTitle} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  return join(storageRoot, "Series", safeTitle, `Season ${season}`, `${episodeLabel}.mp4`);
}
