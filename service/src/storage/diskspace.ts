import { statfs } from "node:fs/promises";

/** Best-effort free space in bytes for the filesystem containing `path`. Null if unavailable (e.g. unsupported platform). */
export async function getFreeBytes(path: string): Promise<number | null> {
  try {
    const stats = await statfs(path);
    return stats.bsize * stats.bavail;
  } catch {
    return null;
  }
}

/** Free and total capacity for the filesystem containing `path` — feeds StorageTarget.bytesFree/bytesTotal. Null if unavailable (e.g. Windows, where fs.statfs isn't supported — see PROGRESS.md's environment notes). */
export async function getDiskUsage(path: string): Promise<{ freeBytes: number; totalBytes: number } | null> {
  try {
    const stats = await statfs(path);
    return { freeBytes: stats.bsize * stats.bavail, totalBytes: stats.bsize * stats.blocks };
  } catch {
    return null;
  }
}

/**
 * Pre-flight/periodic disk-space guard — CLAUDE.md §4: free space must be at
 * least expectedSize × 1.3 (headroom for the P4 remux step) before/while a
 * download proceeds. Returns true (safe to proceed) when free space can't be
 * determined at all, since refusing to ever download on an unsupported
 * platform is worse than the rare case this guard exists to prevent.
 */
export async function hasSufficientSpace(path: string, expectedBytes: number): Promise<boolean> {
  const free = await getFreeBytes(path);
  if (free === null) return true;
  return free >= expectedBytes * 1.3;
}
