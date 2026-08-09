import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDbConnection } from "../db/client.js";
import { enqueueDownload, getById, markQueued } from "../db/downloadItems.js";
import { upsertDebridAccount } from "../db/debridAccounts.js";
import { startTestServer } from "../testutils/fakeHttpServer.js";
import { FakeTorrent, FakeTorrentFile, FakeWebTorrentClient } from "../testutils/fakeTorrentClient.js";
import { partPath } from "../storage/paths.js";
import { step } from "./runner.js";

const MAGNET = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Test";

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

test("a 'magnet' row downloads via the webtorrent fallback, not the HTTP downloader (P6)", async () => {
  const { db, storageRoot } = freshEnv();
  enqueueDownload(db, {
    id: "job-magnet",
    stremioId: "tt6666666",
    seriesId: null,
    type: "movie",
    title: "Magnet Title",
    year: 2023,
    season: null,
    episode: null,
    quality: "1080p",
    sourceKind: "magnet",
    sourceUrl: MAGNET,
    storageTargetId: "default",
  });

  const torrentDir = mkdtempSync(join(tmpdir(), "stremio-offline-runner-magnet-"));
  const file = new FakeTorrentFile("movie.mp4", "movie.mp4", 12);
  writeFileSync(join(torrentDir, "movie.mp4"), "hello world!");
  const torrent = new FakeTorrent([file], torrentDir);
  const client = new FakeWebTorrentClient(torrent);

  const stepPromise = step({ db, storageRoot, backoffCapMs: 50, torrentClient: client });
  await client.whenAdded;
  torrent.emit("done");
  const result = await stepPromise;

  assert.equal(result, "processed");
  const row = getById(db, "job-magnet")!;
  assert.equal(row.status, "remuxing");
  assert.equal(readFileSync(row.filePathOriginal!, "utf8"), "hello world!");
});

test("a 'debrid' row resolves via the configured service, then downloads the direct URL like any HTTP source (P6)", async () => {
  const body = randomBytes(50_000);
  const { url: fileUrl, close } = await startTestServer(body);
  const { db, storageRoot } = freshEnv();

  upsertDebridAccount(db, { service: "realdebrid", apiKey: "test-key", enabled: true });
  enqueueDownload(db, {
    id: "job-debrid",
    stremioId: "tt5555555",
    seriesId: null,
    type: "movie",
    title: "Debrid Title",
    year: 2022,
    season: null,
    episode: null,
    quality: "1080p",
    sourceKind: "debrid",
    sourceUrl: MAGNET,
    storageTargetId: "default",
  });

  // Fakes only the Real-Debrid API calls; the actual file download is
  // delegated to the real fetch, hitting a real local Range-capable test
  // server — exercises the exact same downloadToPart() path as sourceKind
  // "http", proving the resolved URL flows through unmodified.
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = input.toString();
    if (u.includes("real-debrid.com")) {
      if (u.endsWith("/torrents/addMagnet")) {
        return { ok: true, status: 200, json: async () => ({ id: "tor-1" }) } as Response;
      }
      if (u.endsWith("/torrents/info/tor-1")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "downloaded", files: [], links: ["https://real-debrid.com/d/abc"] }),
        } as Response;
      }
      if (u.endsWith("/unrestrict/link")) {
        return { ok: true, status: 200, json: async () => ({ download: fileUrl }) } as Response;
      }
      throw new Error(`unexpected Real-Debrid URL: ${u}`);
    }
    return fetch(input as string, init);
  }) as unknown as typeof fetch;

  try {
    const result = await step({ db, storageRoot, backoffCapMs: 50, fetchImpl: fakeFetch });
    assert.equal(result, "processed");

    const row = getById(db, "job-debrid")!;
    assert.equal(row.status, "remuxing");
    assert.deepEqual(readFileSync(row.filePathOriginal!), body);
  } finally {
    await close();
  }
});

test("a 'debrid' row with no configured service fails immediately (terminal, not retryable)", async () => {
  const { db, storageRoot } = freshEnv();
  enqueueDownload(db, {
    id: "job-no-debrid",
    stremioId: "tt7777777",
    seriesId: null,
    type: "movie",
    title: "No Debrid Title",
    year: 2024,
    season: null,
    episode: null,
    quality: "1080p",
    sourceKind: "debrid",
    sourceUrl: MAGNET,
    storageTargetId: "default",
  });

  const result = await step({ db, storageRoot, backoffCapMs: 50 });
  assert.equal(result, "processed");
  const row = getById(db, "job-no-debrid")!;
  assert.equal(row.status, "failed");
});
