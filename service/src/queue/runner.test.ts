import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDbConnection } from "../db/client.js";
import { enqueueDownload, getById, markQueued } from "../db/downloadItems.js";
import { startTestServer } from "../testutils/fakeHttpServer.js";
import { partPath } from "../storage/paths.js";
import { step } from "./runner.js";

function freshEnv() {
  const storageRoot = mkdtempSync(join(tmpdir(), "stremio-offline-runner-test-"));
  const db = createDbConnection(join(storageRoot, ".offline", "db.sqlite"));
  return { db, storageRoot };
}

test("idle when there's nothing queued or paused", async () => {
  const { db, storageRoot } = freshEnv();
  const result = await step({ db, storageRoot, backoffCapMs: 50 });
  assert.equal(result, "idle");
});

test("processes a queued item end-to-end: downloads, verifies, and lands in remuxing", async () => {
  const body = randomBytes(100_000);
  const { url, close } = await startTestServer(body);
  const { db, storageRoot } = freshEnv();

  enqueueDownload(db, {
    id: "job-1",
    stremioId: "tt0903747",
    seriesId: null,
    type: "movie",
    title: "The Matrix",
    year: 1999,
    season: null,
    episode: null,
    quality: "1080p",
    sourceKind: "http",
    sourceUrl: url,
    storageTargetId: "default",
  });

  try {
    const result = await step({ db, storageRoot, backoffCapMs: 50 });
    assert.equal(result, "processed");

    const row = getById(db, "job-1")!;
    assert.equal(row.status, "remuxing");
    assert.ok(row.filePathOriginal);
    assert.ok(existsSync(row.filePathOriginal!));
    assert.deepEqual(readFileSync(row.filePathOriginal!), body);

    // The .part file must be gone — atomic rename, not a copy left behind.
    assert.equal(existsSync(partPath(storageRoot, "job-1")), false);

    const dbRow = db.prepare("SELECT sha256, bytes_downloaded, bytes_total FROM download_items WHERE id = ?").get("job-1") as {
      sha256: string;
      bytes_downloaded: number;
      bytes_total: number;
    };
    assert.equal(dbRow.sha256, createHash("sha256").update(body).digest("hex"));
    assert.equal(dbRow.bytes_downloaded, body.length);
    assert.equal(dbRow.bytes_total, body.length);
  } finally {
    await close();
  }
});

test("a crashed download resumes correctly on the next step() after being requeued", async () => {
  const body = randomBytes(150_000);
  const { url, close, state } = await startTestServer(body);
  const { db, storageRoot } = freshEnv();

  enqueueDownload(db, {
    id: "job-2",
    stremioId: "tt1111111",
    seriesId: null,
    type: "movie",
    title: "Crash Test",
    year: 2020,
    season: null,
    episode: null,
    quality: "1080p",
    sourceKind: "http",
    sourceUrl: url,
    storageTargetId: "default",
  });

  try {
    state.truncateAfterBytes = 50_000;
    await step({ db, storageRoot, backoffCapMs: 50 });

    // The row should NOT have completed — either paused or requeued after a retryable error.
    const afterCrash = getById(db, "job-2")!;
    assert.notEqual(afterCrash.status, "remuxing");

    // Simulate "the operator/reconciler puts it back in the queue" (reconcile.ts's job on real boot).
    markQueued(db, "job-2");

    const result = await step({ db, storageRoot, backoffCapMs: 50 });
    assert.equal(result, "processed");

    const finalRow = getById(db, "job-2")!;
    assert.equal(finalRow.status, "remuxing");
    assert.deepEqual(readFileSync(finalRow.filePathOriginal!), body, "resumed download must match the source exactly");
  } finally {
    await close();
  }
});

test("resumes network-paused items instead of leaving them stuck", async () => {
  const { db, storageRoot } = freshEnv();
  enqueueDownload(db, {
    id: "job-3",
    stremioId: "tt2222222",
    seriesId: null,
    type: "movie",
    title: "Offline Title",
    year: 2021,
    season: null,
    episode: null,
    quality: "1080p",
    sourceKind: "http",
    sourceUrl: "https://example.invalid/x",
    storageTargetId: "default",
  });
  db.prepare("UPDATE download_items SET status = 'paused', retryable_error = 1 WHERE id = ?").run("job-3");

  const result = await step({ db, storageRoot, backoffCapMs: 50 });
  assert.equal(result, "resumed-paused");
  assert.equal(getById(db, "job-3")!.status, "queued");
});
