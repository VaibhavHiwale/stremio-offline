import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDbConnection } from "./client.js";
import {
  deleteStorageTarget,
  getStorageTarget,
  listStorageTargets,
  updateStorageTargetUsage,
  upsertStorageTarget,
} from "./storageTargets.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "stremio-offline-storagetargets-test-"));
  return createDbConnection(join(dir, "db.sqlite"));
}

test("upsert creates a new target, retrievable by id and in the list", () => {
  const db = freshDb();
  upsertStorageTarget(db, { id: "default", label: "Default", path: "/data", isRemovable: false, isDefault: true, writable: true });

  const target = getStorageTarget(db, "default")!;
  assert.equal(target.label, "Default");
  assert.equal(target.path, "/data");
  assert.equal(target.isDefault, true);
  assert.equal(target.isRemovable, false);
  assert.equal(target.writable, true);
  assert.equal(target.bytesFree, 0);

  assert.equal(listStorageTargets(db).length, 1);
});

test("upsert with the same id replaces fields rather than duplicating the row", () => {
  const db = freshDb();
  upsertStorageTarget(db, { id: "usb-1", label: "Old Label", path: "/mnt/old", isRemovable: true, isDefault: false, writable: true });
  upsertStorageTarget(db, { id: "usb-1", label: "New Label", path: "/mnt/new", isRemovable: true, isDefault: false, writable: false });

  assert.equal(listStorageTargets(db).length, 1);
  const target = getStorageTarget(db, "usb-1")!;
  assert.equal(target.label, "New Label");
  assert.equal(target.path, "/mnt/new");
  assert.equal(target.writable, false);
});

test("updateStorageTargetUsage updates only the usage figures", () => {
  const db = freshDb();
  upsertStorageTarget(db, { id: "default", label: "Default", path: "/data", isRemovable: false, isDefault: true, writable: true });
  updateStorageTargetUsage(db, "default", { bytesFree: 1000, bytesTotal: 5000 });

  const target = getStorageTarget(db, "default")!;
  assert.equal(target.bytesFree, 1000);
  assert.equal(target.bytesTotal, 5000);
  assert.equal(target.label, "Default", "unrelated fields must be untouched");
});

test("listStorageTargets orders the default target first, then alphabetically by label", () => {
  const db = freshDb();
  upsertStorageTarget(db, { id: "b", label: "Zebra", path: "/z", isRemovable: true, isDefault: false, writable: true });
  upsertStorageTarget(db, { id: "a", label: "Apple", path: "/a", isRemovable: true, isDefault: false, writable: true });
  upsertStorageTarget(db, { id: "default", label: "Default", path: "/data", isRemovable: false, isDefault: true, writable: true });

  const ids = listStorageTargets(db).map((t) => t.id);
  assert.deepEqual(ids, ["default", "a", "b"]);
});

test("deleteStorageTarget removes the row and reports whether one existed", () => {
  const db = freshDb();
  upsertStorageTarget(db, { id: "usb-1", label: "USB", path: "/mnt/usb", isRemovable: true, isDefault: false, writable: true });

  assert.equal(deleteStorageTarget(db, "usb-1"), true);
  assert.equal(getStorageTarget(db, "usb-1"), undefined);
  assert.equal(deleteStorageTarget(db, "usb-1"), false);
});
