import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDbConnection } from "./client.js";
import {
  cancelOrDeleteDownload,
  enqueueDownload,
  getById,
  getFullById,
  getQueuedRows,
  listAll,
  markAwaitingRemux,
  markFailed,
  markPaused,
  markReady,
  pauseDownload,
  resumeDownload,
  retryDownload,
  setPriority,
} from "./downloadItems.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "stremio-offline-test-"));
  return createDbConnection(join(dir, "db.sqlite"));
}

const BASE_ITEM = {
  stremioId: "tt0903747",
  seriesId: null,
  type: "movie" as const,
  title: "The Matrix",
  year: 1999,
  season: null,
  episode: null,
  quality: "1080p",
  sourceKind: "http",
  sourceUrl: "https://example.invalid/matrix.mp4",
  storageTargetId: "default",
};

test("enqueueing the same title+quality twice rapidly creates exactly one job", () => {
  const db = freshDb();
  enqueueDownload(db, { ...BASE_ITEM, id: "job-1" });
  enqueueDownload(db, { ...BASE_ITEM, id: "job-2" }); // different id, same (stremioId, quality)

  const count = (db.prepare("SELECT COUNT(*) AS n FROM download_items").get() as { n: number }).n;
  assert.equal(count, 1);
  assert.ok(getById(db, "job-1"), "the first insert should have won");
  assert.equal(getById(db, "job-2"), undefined);
});

test("different quality for the same title creates a separate job", () => {
  const db = freshDb();
  enqueueDownload(db, { ...BASE_ITEM, id: "job-1080", quality: "1080p" });
  enqueueDownload(db, { ...BASE_ITEM, id: "job-720", quality: "720p" });

  const count = (db.prepare("SELECT COUNT(*) AS n FROM download_items").get() as { n: number }).n;
  assert.equal(count, 2);
});

test("enqueueDownload reports whether it actually inserted", () => {
  const db = freshDb();
  assert.equal(enqueueDownload(db, { ...BASE_ITEM, id: "job-1" }), true);
  assert.equal(enqueueDownload(db, { ...BASE_ITEM, id: "job-2" }), false, "duplicate (stremioId, quality) should report no insert");
});

test("getQueuedRows orders by priority DESC, then added_at ASC within a band", () => {
  const db = freshDb();
  enqueueDownload(db, { ...BASE_ITEM, id: "a", stremioId: "tt1", quality: "1080p" });
  enqueueDownload(db, { ...BASE_ITEM, id: "b", stremioId: "tt2", quality: "1080p" });
  enqueueDownload(db, { ...BASE_ITEM, id: "c", stremioId: "tt3", quality: "1080p" });
  db.prepare("UPDATE download_items SET priority = 5 WHERE id = 'b'").run();

  const rows = getQueuedRows(db, 10);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["b", "a", "c"],
    "b has higher priority so it comes first; a/c share a band and keep insertion order",
  );
});

test("pauseDownload: queued/downloading -> paused; rejects other states; 404s on unknown id", () => {
  const db = freshDb();
  enqueueDownload(db, { ...BASE_ITEM, id: "queued-1" });
  assert.equal(pauseDownload(db, "queued-1"), "ok");
  assert.equal(getById(db, "queued-1")!.status, "paused");

  markReady(db, "queued-1", { filePathWebReady: "/x.mp4" });
  assert.equal(pauseDownload(db, "queued-1"), "invalid-state");

  assert.equal(pauseDownload(db, "no-such-id"), "not-found");
});

test("resumeDownload: only valid from paused", () => {
  const db = freshDb();
  enqueueDownload(db, { ...BASE_ITEM, id: "row-1" });
  assert.equal(resumeDownload(db, "row-1"), "invalid-state", "still queued, nothing to resume");

  pauseDownload(db, "row-1");
  assert.equal(resumeDownload(db, "row-1"), "ok");
  assert.equal(getById(db, "row-1")!.status, "queued");

  assert.equal(resumeDownload(db, "no-such-id"), "not-found");
});

test("retryDownload: only valid from failed, resets the attempt budget", () => {
  const db = freshDb();
  enqueueDownload(db, { ...BASE_ITEM, id: "row-1" });
  assert.equal(retryDownload(db, "row-1"), "invalid-state", "still queued, nothing to retry");

  markFailed(db, "row-1", "boom", true);
  db.prepare("UPDATE download_items SET attempt_count = 7 WHERE id = 'row-1'").run();
  assert.equal(retryDownload(db, "row-1"), "ok");
  const row = getById(db, "row-1")!;
  assert.equal(row.status, "queued");
  assert.equal(row.attemptCount, 0, "manual retry gets a fresh attempt budget");

  assert.equal(retryDownload(db, "no-such-id"), "not-found");
});

test("setPriority updates the row and reports whether it found one", () => {
  const db = freshDb();
  enqueueDownload(db, { ...BASE_ITEM, id: "row-1" });
  assert.equal(setPriority(db, "row-1", 9), true);
  assert.equal(getById(db, "row-1")!.priority, 9);
  assert.equal(setPriority(db, "no-such-id", 9), false);
});

test("cancelOrDeleteDownload: in-flight statuses become cancelled, ready becomes deleted, and it's idempotent", () => {
  const db = freshDb();
  enqueueDownload(db, { ...BASE_ITEM, id: "queued-1" });
  enqueueDownload(db, { ...BASE_ITEM, id: "ready-1", stremioId: "tt-ready" });
  markReady(db, "ready-1", { filePathWebReady: "/x.mp4" });

  assert.deepEqual(cancelOrDeleteDownload(db, "queued-1"), { status: "cancelled" });
  assert.deepEqual(cancelOrDeleteDownload(db, "ready-1"), { status: "deleted" });

  assert.equal(cancelOrDeleteDownload(db, "queued-1"), "already-gone", "deleting twice is a no-op, not an error");
  assert.equal(cancelOrDeleteDownload(db, "no-such-id"), "not-found");
});

test("a cancelled row cannot be resurrected by a late-finishing job's completion write", () => {
  const db = freshDb();
  enqueueDownload(db, { ...BASE_ITEM, id: "row-1" });
  cancelOrDeleteDownload(db, "row-1");
  assert.equal(getById(db, "row-1")!.status, "cancelled");

  // Simulates the in-flight job's completion handler firing after the user
  // already cancelled it — none of these should be able to flip it back.
  markPaused(db, "row-1", "network blip");
  assert.equal(getById(db, "row-1")!.status, "cancelled");

  markFailed(db, "row-1", "boom", true);
  assert.equal(getById(db, "row-1")!.status, "cancelled");

  markAwaitingRemux(db, "row-1", { filePathOriginal: "/x.mkv", bytesDownloaded: 10, bytesTotal: 10, sha256: "abc" });
  assert.equal(getById(db, "row-1")!.status, "cancelled");

  markReady(db, "row-1", { filePathWebReady: "/x.mp4" });
  assert.equal(getById(db, "row-1")!.status, "cancelled");
});

test("getFullById / listAll return the complete DownloadItem shape with correct types", () => {
  const db = freshDb();
  enqueueDownload(db, { ...BASE_ITEM, id: "row-1" });

  const item = getFullById(db, "row-1")!;
  assert.equal(item.id, "row-1");
  assert.equal(item.status, "queued");
  assert.equal(typeof item.watched, "boolean");
  assert.equal(item.watched, false);
  assert.deepEqual(item.subtitleLangs, []);

  assert.equal(getFullById(db, "no-such-id"), undefined);

  const all = listAll(db);
  assert.equal(all.length, 1);
  assert.equal(listAll(db, { status: "queued" }).length, 1);
  assert.equal(listAll(db, { status: "ready" }).length, 0);
});
