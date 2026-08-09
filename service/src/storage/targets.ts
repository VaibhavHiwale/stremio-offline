import type { Database } from "better-sqlite3";
import {
  listStorageTargets,
  updateStorageTargetUsage,
  upsertStorageTarget,
} from "../db/storageTargets.js";
import { getDiskUsage } from "./diskspace.js";

export const DEFAULT_STORAGE_TARGET_ID = "default";

/**
 * Ensures the `default` storage target — the server's own storage root —
 * always exists, registered at boot. CLAUDE.md §2's locked-in deployment
 * decision means "discover storage targets" is a manual/admin task on a
 * headless NAS/Pi (the operator knows their own mount points), not
 * automatic OS-wide volume enumeration; `POST /storage/targets` is how an
 * admin registers an external SD/USB/NAS path beyond this default one.
 */
export function ensureDefaultTarget(db: Database, storageRoot: string): void {
  upsertStorageTarget(db, {
    id: DEFAULT_STORAGE_TARGET_ID,
    label: "Default",
    path: storageRoot,
    isRemovable: false,
    isDefault: true,
    writable: true,
  });
}

/** Refreshes bytesFree/bytesTotal for every registered target — best-effort, a target whose path is temporarily unreachable (unmounted USB drive) just keeps its last-known figures. */
export async function refreshAllTargetUsage(db: Database): Promise<void> {
  for (const target of listStorageTargets(db)) {
    const usage = await getDiskUsage(target.path);
    if (usage) updateStorageTargetUsage(db, target.id, { bytesFree: usage.freeBytes, bytesTotal: usage.totalBytes });
  }
}
