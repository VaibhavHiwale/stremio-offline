import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDbConnection } from "./client.js";
import { enqueueDownload, getById } from "./downloadItems.js";

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
