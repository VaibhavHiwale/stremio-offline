import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDbConnection } from "../db/client.js";
import { getById } from "../db/downloadItems.js";
import { partPath } from "../storage/paths.js";
import { reconcile } from "./reconcile.js";

function freshEnv() {
  const storageRoot = mkdtempSync(join(tmpdir(), "stremio-offline-reconcile-"));
  const db = createDbConnection(join(storageRoot, ".offline", "db.sqlite"));
  return { db, storageRoot };
}

function insertRaw(
  db: ReturnType<typeof createDbConnection>,
  row: Partial<{
    id: string;
    stremioId: string;
    quality: string;
    status: string;
    bytesTotal: number | null;
    filePathOriginal: string | null;
  }>,
) {
  db.prepare(
    `INSERT INTO download_items
       (id, stremio_id, series_id, type, title, year, season, episode, quality, source_kind, source_url,
        status, storage_target_id, bytes_total, file_path_original, added_at)
     VALUES (?, ?, NULL, 'movie', 'Title', NULL, NULL, NULL, ?, 'http', 'https://example.invalid/x',
        ?, 'default', ?, ?, datetime('now'))`,
  ).run(
    row.id,
    row.stremioId ?? row.id,
    row.quality ?? "1080p",
    row.status ?? "downloading",
    row.bytesTotal ?? null,
    row.filePathOriginal ?? null,
  );
}

test("interrupted download with a partial .part file is requeued with the real on-disk size", async () => {
  const { db, storageRoot } = freshEnv();
  insertRaw(db, { id: "a", status: "downloading", bytesTotal: 1000 });
  const partFile = partPath(storageRoot, "a");
  mkdirSync(join(partFile, ".."), { recursive: true });
  writeFileSync(partFile, Buffer.alloc(400));

  await reconcile(db, storageRoot);

  const row = getById(db, "a")!;
  assert.equal(row.status, "queued");
  assert.equal(row.bytesDownloaded, 400);
});

test("interrupted download with no .part file at all is requeued from zero", async () => {
  const { db, storageRoot } = freshEnv();
  insertRaw(db, { id: "b", status: "downloading", bytesTotal: 1000 });

  await reconcile(db, storageRoot);

  const row = getById(db, "b")!;
  assert.equal(row.status, "queued");
  assert.equal(row.bytesDownloaded, 0);
});

test("remuxing row whose original file still exists is left alone", async () => {
  const { db, storageRoot } = freshEnv();
  const originalFile = join(storageRoot, "original.mkv");
  writeFileSync(originalFile, Buffer.alloc(10));
  insertRaw(db, { id: "c", status: "remuxing", filePathOriginal: originalFile });

  await reconcile(db, storageRoot);

  assert.equal(getById(db, "c")!.status, "remuxing");
});

test("remuxing row whose original file vanished is marked failed", async () => {
  const { db, storageRoot } = freshEnv();
  insertRaw(db, { id: "d", status: "remuxing", filePathOriginal: join(storageRoot, "gone.mkv") });

  await reconcile(db, storageRoot);

  assert.equal(getById(db, "d")!.status, "failed");
});

test("orphan .part files with no matching row are deleted", async () => {
  const { db, storageRoot } = freshEnv();
  const orphanFile = partPath(storageRoot, "no-such-id");
  mkdirSync(join(orphanFile, ".."), { recursive: true });
  writeFileSync(orphanFile, Buffer.alloc(5));

  const result = await reconcile(db, storageRoot);

  assert.ok(result.orphansDeleted.includes("no-such-id.part"));
});

test("reboot with 5 queued + 2 interrupted downloads: all 7 present and correct afterward", async () => {
  const { db, storageRoot } = freshEnv();
  for (let i = 0; i < 5; i++) insertRaw(db, { id: `queued-${i}`, status: "queued" });
  for (let i = 0; i < 2; i++) {
    insertRaw(db, { id: `active-${i}`, status: "downloading", bytesTotal: 500 });
    const p = partPath(storageRoot, `active-${i}`);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, Buffer.alloc(200));
  }

  await reconcile(db, storageRoot);

  const rows = db.prepare("SELECT id, status FROM download_items").all() as { id: string; status: string }[];
  assert.equal(rows.length, 7);
  assert.ok(rows.every((r) => r.status === "queued"), "every row should have ended up queued");
});
