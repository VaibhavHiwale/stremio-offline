import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDbConnection } from "../db/client.js";
import { sweepAutoDelete } from "./autodelete.js";

function freshEnv() {
  const storageRoot = mkdtempSync(join(tmpdir(), "stremio-offline-autodelete-test-"));
  const db = createDbConnection(join(storageRoot, ".offline", "db.sqlite"));
  return { db, storageRoot };
}

function insertReadyRow(
  db: ReturnType<typeof createDbConnection>,
  row: {
    id: string;
    filePath: string;
    watched?: boolean;
    autoDeleteAfterWatch?: boolean;
    completedDaysAgo?: number;
  },
) {
  const completedAt = row.completedDaysAgo !== undefined ? `datetime('now', '-${row.completedDaysAgo} days')` : "datetime('now')";
  db.prepare(
    `INSERT INTO download_items
       (id, stremio_id, series_id, type, title, year, season, episode, quality, source_kind, source_url,
        status, storage_target_id, file_path_web_ready, watched, auto_delete_after_watch, completed_at, added_at)
     VALUES (?, ?, NULL, 'movie', 'Title', 2020, NULL, NULL, '1080p', 'http', 'https://example.invalid/x',
        'ready', 'default', ?, ?, ?, ${completedAt}, datetime('now'))`,
  ).run(row.id, row.id, row.filePath, row.watched ? 1 : 0, row.autoDeleteAfterWatch ? 1 : 0);
}

test("deletes a row whose per-item autoDeleteAfterWatch is set and has been watched", async () => {
  const { db, storageRoot } = freshEnv();
  const filePath = join(storageRoot, "movie.mp4");
  writeFileSync(filePath, "fake video");
  insertReadyRow(db, { id: "row-1", filePath, watched: true, autoDeleteAfterWatch: true });

  const deleted = await sweepAutoDelete({ db, storageRoot });

  assert.deepEqual(deleted, ["row-1"]);
  assert.equal(existsSync(filePath), false);
  const status = (db.prepare("SELECT status FROM download_items WHERE id = 'row-1'").get() as { status: string }).status;
  assert.equal(status, "deleted");
});

test("does not delete a watched row without autoDeleteAfterWatch set (per-item or global)", async () => {
  const { db, storageRoot } = freshEnv();
  const filePath = join(storageRoot, "movie.mp4");
  writeFileSync(filePath, "fake video");
  insertReadyRow(db, { id: "row-1", filePath, watched: true, autoDeleteAfterWatch: false });

  const deleted = await sweepAutoDelete({ db, storageRoot });

  assert.deepEqual(deleted, []);
  assert.equal(existsSync(filePath), true);
});

test("respects the global settings.auto_delete_after_watch default even without a per-item flag", async () => {
  const { db, storageRoot } = freshEnv();
  db.prepare("UPDATE settings SET auto_delete_after_watch = 1 WHERE id = 1").run();
  const filePath = join(storageRoot, "movie.mp4");
  writeFileSync(filePath, "fake video");
  insertReadyRow(db, { id: "row-1", filePath, watched: true, autoDeleteAfterWatch: false });

  const deleted = await sweepAutoDelete({ db, storageRoot });
  assert.deepEqual(deleted, ["row-1"]);
});

test("deletes a row older than settings.auto_delete_after_days regardless of watched status", async () => {
  const { db, storageRoot } = freshEnv();
  db.prepare("UPDATE settings SET auto_delete_after_days = 30 WHERE id = 1").run();
  const filePath = join(storageRoot, "movie.mp4");
  writeFileSync(filePath, "fake video");
  insertReadyRow(db, { id: "row-1", filePath, watched: false, completedDaysAgo: 45 });

  const deleted = await sweepAutoDelete({ db, storageRoot });
  assert.deepEqual(deleted, ["row-1"]);
});

test("does not delete a row younger than settings.auto_delete_after_days", async () => {
  const { db, storageRoot } = freshEnv();
  db.prepare("UPDATE settings SET auto_delete_after_days = 30 WHERE id = 1").run();
  const filePath = join(storageRoot, "movie.mp4");
  writeFileSync(filePath, "fake video");
  insertReadyRow(db, { id: "row-1", filePath, watched: false, completedDaysAgo: 10 });

  const deleted = await sweepAutoDelete({ db, storageRoot });
  assert.deepEqual(deleted, []);
});

test("never touches a row that isn't 'ready' yet", async () => {
  const { db, storageRoot } = freshEnv();
  db.prepare("UPDATE settings SET auto_delete_after_watch = 1 WHERE id = 1").run();
  db.prepare(
    `INSERT INTO download_items
       (id, stremio_id, series_id, type, title, year, season, episode, quality, source_kind, source_url,
        status, storage_target_id, watched, auto_delete_after_watch, added_at)
     VALUES ('row-1', 'row-1', NULL, 'movie', 'Title', 2020, NULL, NULL, '1080p', 'http', 'https://example.invalid/x',
        'downloading', 'default', 1, 1, datetime('now'))`,
  ).run();

  const deleted = await sweepAutoDelete({ db, storageRoot });
  assert.deepEqual(deleted, []);
});
