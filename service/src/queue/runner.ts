import { promises as fsp } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "better-sqlite3";
import { sleep, backoffMs } from "../util/backoff.js";
import {
  type QueueRow,
  getNextQueued,
  getPausedForNetworkLoss,
  incrementAttempt,
  markAwaitingRemux,
  markDownloading,
  markFailed,
  markPaused,
  markQueued,
  setEtag,
  updateProgress,
} from "../db/downloadItems.js";
import { downloadToPart } from "../downloaders/http.js";
import { computeSha256 } from "../media/verify.js";
import { originalPath, partPath } from "../storage/paths.js";

const MAX_ATTEMPTS = 10;

export interface RunnerDeps {
  db: Database;
  storageRoot: string;
  fetchImpl?: typeof fetch;
  /** Cap on retry backoff — overridable so tests don't wait 5 real minutes. */
  backoffCapMs?: number;
  /** Aborts the in-flight download promptly on shutdown instead of waiting for it to finish naturally. */
  signal?: AbortSignal;
}

export type StepResult = "processed" | "resumed-paused" | "idle";

/**
 * Runs exactly one unit of queue work, single-lane. Superseded in
 * production by queue/scheduler.ts's concurrent pool (P5), which reuses
 * processItem() below; this stays so P3's chaos tests (resume, disk-full
 * pause, network-loss pause, reconciliation) have a simple, deterministic
 * driver.
 */
export async function step(deps: RunnerDeps): Promise<StepResult> {
  const paused = getPausedForNetworkLoss(deps.db);
  if (paused.length > 0) {
    for (const row of paused) markQueued(deps.db, row.id);
    return "resumed-paused";
  }

  const next = getNextQueued(deps.db);
  if (!next) return "idle";

  await processItem(deps, next);
  return "processed";
}

/** Exported so queue/scheduler.ts (P5) can drive many of these concurrently instead of one at a time. */
export async function processItem(deps: RunnerDeps, row: QueueRow): Promise<void> {
  markDownloading(deps.db, row.id);
  const dest = partPath(deps.storageRoot, row.id);

  const downloadDeps: Parameters<typeof downloadToPart>[3] = {
    onProgress: (bytesDownloaded, bytesTotal) =>
      updateProgress(deps.db, row.id, { bytesDownloaded, bytesTotal, speedBps: null, etaSeconds: null }),
    // Persisted immediately, not just on success — a later resume attempt
    // needs to know what ETag *this* attempt started from even if it dies mid-stream.
    onHeaders: (info) => {
      if (info.etag) setEtag(deps.db, row.id, info.etag);
    },
  };
  if (deps.fetchImpl) downloadDeps.fetchImpl = deps.fetchImpl;
  if (deps.signal) downloadDeps.signal = deps.signal;

  const outcome = await downloadToPart(row.sourceUrl, dest, { knownEtag: row.sourceEtag }, downloadDeps);

  switch (outcome.kind) {
    case "complete": {
      const finalPath = originalPath(deps.storageRoot, row.id, row.sourceUrl);
      await fsp.mkdir(dirname(finalPath), { recursive: true });
      const sha256 = await computeSha256(dest);
      await fsp.rename(dest, finalPath); // atomic within a filesystem — CLAUDE.md §4
      markAwaitingRemux(deps.db, row.id, {
        filePathOriginal: finalPath,
        bytesDownloaded: outcome.bytesTotal,
        bytesTotal: outcome.bytesTotal,
        sha256,
      });
      return;
    }
    case "paused-disk-full":
      markPaused(deps.db, row.id, "disk full — queue paused until space frees up");
      return;
    case "paused-network":
      markPaused(deps.db, row.id, outcome.message);
      return;
    case "retryable-error": {
      incrementAttempt(deps.db, row.id);
      if (row.attemptCount + 1 >= MAX_ATTEMPTS) {
        markFailed(deps.db, row.id, `${outcome.message} (${MAX_ATTEMPTS} attempts exhausted)`, true);
        return;
      }
      // Single-lane runner: wait out the backoff here rather than racing
      // other items — P5's concurrent scheduler will do this per-item instead.
      await sleep(backoffMs(row.attemptCount, deps.backoffCapMs));
      markQueued(deps.db, row.id);
      return;
    }
    case "terminal-error":
    case "verification-failed":
      markFailed(deps.db, row.id, outcome.message, false);
      return;
  }
}

