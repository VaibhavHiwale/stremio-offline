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
