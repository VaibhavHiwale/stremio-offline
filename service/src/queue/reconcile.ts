import { promises as fsp } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { getInterruptedDownloads, getRemuxingRows, markFailed, markQueued, updateProgress } from "../db/downloadItems.js";
import { partPath } from "../storage/paths.js";

export interface ReconcileResult {
  requeued: string[];
  markedFailed: string[];
  orphansDeleted: string[];
}

async function statSizeOrNull(path: string): Promise<number | null> {
  try {
    return (await fsp.stat(path)).size;
  } catch {
    return null;
  }
}

/**
 * Boot-time reconciliation — CLAUDE.md §4 Crash safety: "The DB is a cache
 * of filesystem reality, never the other way round." Runs once at startup,
 * before the queue runner starts pulling jobs.
 */
export async function reconcile(db: Database, storageRoot: string): Promise<ReconcileResult> {
  const result: ReconcileResult = { requeued: [], markedFailed: [], orphansDeleted: [] };

  for (const row of getInterruptedDownloads(db)) {
    const partFile = partPath(storageRoot, row.id);
    const size = await statSizeOrNull(partFile);
    updateProgress(db, row.id, { bytesDownloaded: size ?? 0, bytesTotal: row.bytesTotal, speedBps: null, etaSeconds: null });
    markQueued(db, row.id);
    result.requeued.push(row.id);
  }

  for (const row of getRemuxingRows(db)) {
    if (!row.filePathOriginal) {
      markFailed(db, row.id, "no file_path_original recorded", false);
      result.markedFailed.push(row.id);
      continue;
    }
    const size = await statSizeOrNull(row.filePathOriginal);
    if (size === null) {
      markFailed(db, row.id, "downloaded file missing after restart", false);
      result.markedFailed.push(row.id);
    }
  }

  result.orphansDeleted.push(...(await sweepOrphanParts(db, storageRoot)));
  result.orphansDeleted.push(...(await sweepOrphanRemuxStaging(db, storageRoot)));

  return result;
}

async function sweepOrphanFiles(dir: string, suffix: string, activeIds: Set<string>): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }

  const deleted: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(suffix)) continue;
    const id = entry.slice(0, -suffix.length);
    if (!activeIds.has(id)) {
      await fsp.rm(join(dir, entry), { force: true });
      deleted.push(entry);
    }
  }
  return deleted;
}

async function sweepOrphanParts(db: Database, storageRoot: string): Promise<string[]> {
  const activeIds = new Set(
    (db.prepare("SELECT id FROM download_items WHERE status IN ('queued','downloading','paused')").all() as { id: string }[]).map(
      (r) => r.id,
    ),
  );
  return sweepOrphanFiles(join(storageRoot, ".offline", "parts"), ".part", activeIds);
}

/**
 * `.offline/remux/<id>.remux.mp4` staging files — CLAUDE.md §4 "Orphan
 * sweep on boot". A row cancelled/deleted (P5) mid-remux gets its ffmpeg
 * process killed live via RemuxRunnerHandle.abortRow(), but this covers the
 * case where the whole process died instead (crash, kill -9) before that
 * could happen.
 */
async function sweepOrphanRemuxStaging(db: Database, storageRoot: string): Promise<string[]> {
  const activeIds = new Set(
    (db.prepare("SELECT id FROM download_items WHERE status = 'remuxing'").all() as { id: string }[]).map((r) => r.id),
  );
  return sweepOrphanFiles(join(storageRoot, ".offline", "remux"), ".remux.mp4", activeIds);
}
