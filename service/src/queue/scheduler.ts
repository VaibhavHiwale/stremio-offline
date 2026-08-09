import type { Database } from "better-sqlite3";
import { getPausedForNetworkLoss, getQueuedRows, markQueued, type QueueRow } from "../db/downloadItems.js";
import { getMaxConcurrentDownloads } from "../db/settings.js";
import { recordError } from "../observability/errorLog.js";
import { sleep } from "../util/backoff.js";
import { processItem, type RunnerDeps } from "./runner.js";

export interface SchedulerDeps {
  db: Database;
  storageRoot: string;
  /** For correlating error records — defaults to "unknown" so tests don't need to supply one. */
  installIdHash?: string;
  fetchImpl?: typeof fetch;
  /** Cap on retry backoff — overridable so tests don't wait 5 real minutes. */
  backoffCapMs?: number;
  idlePollMs?: number;
}

export interface SchedulerHandle {
  stop: () => Promise<void>;
  /** Aborts the in-flight download for this row if one is running here (used by PATCH .../pause and DELETE). Returns whether a job was actually found. */
  abortRow: (id: string) => boolean;
  /** Currently-downloading count — feeds /health's activeJobs. */
  activeCount: () => number;
}

/**
 * The real concurrent queue processor — CLAUDE.md §10 P5: "scheduler,
 * priority, concurrency". Reuses processItem() from runner.ts (P3) so the
 * crash-safety/resume logic isn't duplicated; this only adds running
 * several rows at once, honouring settings.max_concurrent_downloads (read
 * live every poll, no restart needed), priority ordering (delegated to
 * getQueuedRows' ORDER BY), and per-row cancellation for the REST API.
 */
export function startScheduler(deps: SchedulerDeps): SchedulerHandle {
  let stopped = false;
  const rowControllers = new Map<string, AbortController>();
  const inFlight = new Set<string>();
  const pending = new Set<Promise<void>>();

  function runJob(row: QueueRow): void {
    inFlight.add(row.id);
    const controller = new AbortController();
    rowControllers.set(row.id, controller);

    const runnerDeps: RunnerDeps = { db: deps.db, storageRoot: deps.storageRoot, signal: controller.signal };
    if (deps.fetchImpl) runnerDeps.fetchImpl = deps.fetchImpl;
    if (deps.backoffCapMs !== undefined) runnerDeps.backoffCapMs = deps.backoffCapMs;

    const job = processItem(runnerDeps, row)
      .catch((err: unknown) => {
        // An *unexpected* exception from processItem — every anticipated
        // failure mode already resolves normally (markFailed/markPaused/
        // etc.); this only fires for genuine bugs (a resolver throwing
        // instead of returning an error outcome, a DB write failure, ...).
        recordError(deps.storageRoot, "scheduler", err, { installIdHash: deps.installIdHash ?? "unknown" });
      })
      .finally(() => {
        inFlight.delete(row.id);
        rowControllers.delete(row.id);
        pending.delete(job);
      });
    pending.add(job);
  }

  const loop = async (): Promise<void> => {
    while (!stopped) {
      // Same "pause, don't fail" auto-resume as P3's single-lane step().
      for (const row of getPausedForNetworkLoss(deps.db)) markQueued(deps.db, row.id);

      const maxConcurrent = Math.max(1, getMaxConcurrentDownloads(deps.db));
      const capacity = maxConcurrent - inFlight.size;
      if (capacity > 0) {
        const candidates = getQueuedRows(deps.db, capacity + inFlight.size).filter((r) => !inFlight.has(r.id));
        for (const row of candidates.slice(0, capacity)) {
          if (stopped) break;
          runJob(row);
        }
      }

      await sleep(deps.idlePollMs ?? 2000);
    }
  };

  const iteration = loop();

  return {
    stop: async () => {
      stopped = true;
      // Same rationale as P4's remux runner: interrupt in-flight work
      // promptly rather than waiting for it to finish naturally — safe at
      // any point, next boot's reconciliation resumes it correctly.
      for (const controller of rowControllers.values()) controller.abort();
      await iteration;
      await Promise.allSettled([...pending]);
    },
    abortRow: (id: string): boolean => {
      const controller = rowControllers.get(id);
      if (!controller) return false;
      controller.abort();
      return true;
    },
    activeCount: () => inFlight.size,
  };
}
