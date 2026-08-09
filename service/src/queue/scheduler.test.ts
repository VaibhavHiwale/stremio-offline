import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDbConnection } from "../db/client.js";
import { enqueueDownload, getById } from "../db/downloadItems.js";
import { startScheduler } from "./scheduler.js";

function freshEnv() {
  const storageRoot = mkdtempSync(join(tmpdir(), "stremio-offline-scheduler-test-"));
  const db = createDbConnection(join(storageRoot, ".offline", "db.sqlite"));
  return { db, storageRoot };
}

function baseItem(id: string) {
  return {
    id,
    stremioId: id,
    seriesId: null,
    type: "movie" as const,
    title: id,
    year: 2020,
    season: null,
    episode: null,
    quality: "1080p",
    sourceKind: "http",
    storageTargetId: "default",
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Delays the full response by `delayMs` (not a gradual stream) so several
 * requests fired close together stay concurrently in flight — enough to
 * observe real parallelism, unlike fakeHttpServer.ts's one-shot
 * sliceDelayMs, which only slows a single request.
 */
function startSlowServer(bodySize: number, delayMs: number): Promise<{
  url: string;
  close: () => Promise<void>;
  getMaxObserved: () => number;
}> {
  const body = randomBytes(bodySize);
  let current = 0;
  let maxObserved = 0;

  const server: Server = createServer((_req, res) => {
    current++;
    maxObserved = Math.max(maxObserved, current);
    res.writeHead(200, { "Content-Length": String(body.length) });
    setTimeout(() => {
      res.end(body);
      current--;
    }, delayMs);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/file`,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
        getMaxObserved: () => maxObserved,
      });
    });
  });
}

test("respects settings.max_concurrent_downloads: never runs more than N downloads at once", async () => {
  const { db, storageRoot } = freshEnv();
  db.prepare("UPDATE settings SET max_concurrent_downloads = 2 WHERE id = 1").run();

  const { url, close, getMaxObserved } = await startSlowServer(50_000, 200);
  for (let i = 0; i < 4; i++) {
    enqueueDownload(db, { ...baseItem(`job-${i}`), sourceUrl: url });
  }

  const scheduler = startScheduler({ db, storageRoot, idlePollMs: 20 });
  try {
    await waitUntil(() => [0, 1, 2, 3].every((i) => getById(db, `job-${i}`)?.status === "remuxing"), 8000);
  } finally {
    await scheduler.stop();
    await close();
  }

  assert.ok(getMaxObserved() >= 2, `expected real parallelism (>=2 concurrent), observed ${getMaxObserved()}`);
  assert.ok(getMaxObserved() <= 2, `exceeded the configured concurrency limit: observed ${getMaxObserved()}`);
});

test("priority ordering: a higher-priority item is picked before lower-priority ones queued earlier", async () => {
  const { db, storageRoot } = freshEnv();
  db.prepare("UPDATE settings SET max_concurrent_downloads = 1 WHERE id = 1").run();

  const { url, close } = await startSlowServer(20_000, 150);
  enqueueDownload(db, { ...baseItem("low-1"), sourceUrl: url });
  enqueueDownload(db, { ...baseItem("low-2"), sourceUrl: url });
  enqueueDownload(db, { ...baseItem("high"), sourceUrl: url });
  db.prepare("UPDATE download_items SET priority = 10 WHERE id = 'high'").run();

  const scheduler = startScheduler({ db, storageRoot, idlePollMs: 20 });
  try {
    await waitUntil(() => getById(db, "high")?.status !== "queued", 3000);
    // Concurrency is 1, so if "high" was correctly picked first, both
    // low-priority rows must still be untouched at this instant.
    assert.equal(getById(db, "low-1")!.status, "queued");
    assert.equal(getById(db, "low-2")!.status, "queued");
  } finally {
    await scheduler.stop();
    await close();
  }
});

test("abortRow interrupts an in-flight download and leaves it paused, not corrupted", async () => {
  const { db, storageRoot } = freshEnv();
  const { url, close } = await startSlowServer(200_000, 500);
  enqueueDownload(db, { ...baseItem("row-1"), sourceUrl: url });

  const scheduler = startScheduler({ db, storageRoot, idlePollMs: 20 });
  try {
    await waitUntil(() => getById(db, "row-1")?.status === "downloading", 2000);
    const found = scheduler.abortRow("row-1");
    assert.equal(found, true);
    await waitUntil(() => getById(db, "row-1")?.status === "paused", 2000);
  } finally {
    await scheduler.stop();
    await close();
  }
});

test("abortRow on a row with no in-flight job returns false", async () => {
  const { db, storageRoot } = freshEnv();
  const scheduler = startScheduler({ db, storageRoot, idlePollMs: 20 });
  try {
    assert.equal(scheduler.abortRow("no-such-row"), false);
  } finally {
    await scheduler.stop();
  }
});

test("stop() interrupts in-flight work and settles cleanly", async () => {
  const { db, storageRoot } = freshEnv();
  const { url, close } = await startSlowServer(200_000, 500);
  enqueueDownload(db, { ...baseItem("row-1"), sourceUrl: url });

  const scheduler = startScheduler({ db, storageRoot, idlePollMs: 20 });
  try {
    await waitUntil(() => getById(db, "row-1")?.status === "downloading", 2000);
  } finally {
    await scheduler.stop();
    await close();
  }

  // stop() must have resolved without hanging (the try/finally above already
  // proves that); the row should have landed in some sane terminal-ish
  // state rather than being stuck "downloading" forever.
  assert.notEqual(getById(db, "row-1")!.status, "downloading");
});
