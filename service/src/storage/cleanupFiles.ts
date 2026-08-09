import { promises as fsp } from "node:fs";
import { partPath, remuxTempPath } from "./paths.js";

/**
 * Removes every on-disk artifact for a download item — the in-progress
 * `.part`, the remux staging file, the original, and the web-ready file.
 * Best-effort: a path that doesn't exist (most of these, for any given
 * row) is silently skipped. Shared by `DELETE /downloads/:id` (P5) and the
 * auto-delete sweeper (P8) so there's exactly one place that knows every
 * location a download's bytes could be sitting.
 */
export async function cleanupDownloadFiles(
  storageRoot: string,
  row: { id: string; filePathOriginal: string | null; filePathWebReady: string | null },
): Promise<void> {
  const candidates = [
    partPath(storageRoot, row.id),
    remuxTempPath(storageRoot, row.id),
    row.filePathOriginal,
    row.filePathWebReady,
  ].filter((p): p is string => Boolean(p));
  await Promise.all(candidates.map((p) => fsp.rm(p, { force: true }).catch(() => undefined)));
}
