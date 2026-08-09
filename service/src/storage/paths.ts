import { mkdirSync } from "node:fs";
import { extname, join } from "node:path";

/** In-progress download destination — CLAUDE.md §7 library layout: `STORAGE_ROOT/.offline/parts/`. */
export function partPath(storageRoot: string, downloadItemId: string): string {
  return join(storageRoot, ".offline", "parts", `${downloadItemId}.part`);
}

/**
 * Where a completed-but-not-yet-remuxed download lands. Not the final
 * library path (`Movies/<Title>/...`) — that naming depends on metadata
 * formatting that's P4/storage-organization territory, once the remux step
 * exists to produce the web-ready file the library actually serves.
 */
export function originalPath(storageRoot: string, downloadItemId: string, sourceUrl: string): string {
  const ext = guessExtension(sourceUrl);
  return join(storageRoot, ".offline", "originals", `${downloadItemId}${ext}`);
}

/** Staging output for an in-progress remux — never the final library path directly, so a crash mid-remux never leaves a half-written file where the addon might serve it. */
export function remuxTempPath(storageRoot: string, downloadItemId: string): string {
  return join(storageRoot, ".offline", "remux", `${downloadItemId}.remux.mp4`);
}

function guessExtension(sourceUrl: string): string {
  try {
    const ext = extname(new URL(sourceUrl).pathname);
    return ext && ext.length <= 6 ? ext : ".download";
  } catch {
    return ".download";
  }
}

export function ensureParentDir(filePath: string): void {
  mkdirSync(join(filePath, ".."), { recursive: true });
}
