import type { Database } from "better-sqlite3";
import { cancelOrDeleteDownload, getAutoDeleteCandidates } from "../db/downloadItems.js";
import { recordError } from "../observability/errorLog.js";
import { sleep } from "../util/backoff.js";
import { cleanupDownloadFiles } from "./cleanupFiles.js";

export interface AutoDeleteSweeperDeps {
  db: Database;
  storageRoot: string;
  installIdHash?: string;
  idlePollMs?: number;
}

export interface AutoDeleteSweeperHandle {
  stop: () => Promise<void>;
}

/** One pass — exported directly so tests can drive it deterministically, same pattern as processRemuxRow. */
export async function sweepAutoDelete(deps: AutoDeleteSweeperDeps): Promise<string[]> {
  const deleted: string[] = [];
  for (const candidate of getAutoDeleteCandidates(deps.db)) {
    const result = cancelOrDeleteDownload(deps.db, candidate.id);
    if (result === "not-found" || result === "already-gone") continue;
    await cleanupDownloadFiles(deps.storageRoot, candidate);
    deleted.push(candidate.id);
  }
  return deleted;
}

/** Background poller for production use — index.ts wires this up. */
export function startAutoDeleteSweeper(deps: AutoDeleteSweeperDeps): AutoDeleteSweeperHandle {
  let stopped = false;

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        await sweepAutoDelete(deps);
      } catch (err) {
        recordError(deps.storageRoot, "autoDeleteSweeper", err, { installIdHash: deps.installIdHash ?? "unknown" });
      }
      await sleep(deps.idlePollMs ?? 60_000);
    }
  };

  const iteration = loop();

  return {
    stop: async () => {
      stopped = true;
      await iteration;
    },
  };
}
