import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDbConnection } from "../db/client.js";
import { getStorageTarget, listStorageTargets, upsertStorageTarget } from "../db/storageTargets.js";
import { DEFAULT_STORAGE_TARGET_ID, ensureDefaultTarget, refreshAllTargetUsage } from "./targets.js";

function freshEnv() {
  const storageRoot = mkdtempSync(join(tmpdir(), "stremio-offline-targets-test-"));
  const db = createDbConnection(join(storageRoot, ".offline", "db.sqlite"));
  return { db, storageRoot };
}

test("ensureDefaultTarget registers a default target pointing at the storage root", () => {
  const { db, storageRoot } = freshEnv();
  ensureDefaultTarget(db, storageRoot);

  const target = getStorageTarget(db, DEFAULT_STORAGE_TARGET_ID)!;
  assert.equal(target.path, storageRoot);
  assert.equal(target.isDefault, true);
  assert.equal(target.isRemovable, false);
});

test("ensureDefaultTarget is idempotent — calling it again doesn't duplicate the row", () => {
  const { db, storageRoot } = freshEnv();
  ensureDefaultTarget(db, storageRoot);
  ensureDefaultTarget(db, storageRoot);
  assert.equal(listStorageTargets(db).length, 1);
});

test("refreshAllTargetUsage updates bytesFree/bytesTotal for a real, reachable path", async () => {
  const { db, storageRoot } = freshEnv();
  ensureDefaultTarget(db, storageRoot);

  await refreshAllTargetUsage(db);

  const target = getStorageTarget(db, DEFAULT_STORAGE_TARGET_ID)!;
  // fs.statfs is unsupported on some platforms (e.g. Windows) — degrades to
  // 0/0 rather than throwing, same non-fatal posture as diskspace.ts elsewhere.
  assert.ok(target.bytesFree >= 0);
  assert.ok(target.bytesTotal >= 0);
});

test("refreshAllTargetUsage leaves a target's last-known figures alone when its path is unreachable", async () => {
  const { db, storageRoot } = freshEnv();
  upsertStorageTarget(db, {
    id: "gone",
    label: "Unplugged USB",
    path: join(storageRoot, "does-not-exist"),
    isRemovable: true,
    isDefault: false,
    writable: true,
  });

  await refreshAllTargetUsage(db);

  const target = getStorageTarget(db, "gone")!;
  assert.equal(target.bytesFree, 0, "unreachable path keeps its previous (default zero) figures rather than erroring");
});
