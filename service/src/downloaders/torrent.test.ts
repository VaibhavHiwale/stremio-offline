import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeTorrent, FakeTorrentFile, FakeWebTorrentClient as FakeClient } from "../testutils/fakeTorrentClient.js";
import { downloadMagnetToPart } from "./torrent.js";

const MAGNET = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Test";

function freshDest(): { destPath: string; torrentDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "stremio-offline-torrent-test-"));
  const torrentDir = join(dir, "seed");
  mkdirSync(torrentDir, { recursive: true });
  return { destPath: join(dir, "out", "movie.part"), torrentDir };
}

test("selects the largest file, deselects the rest, and moves it to destPath on completion", async () => {
  const { destPath, torrentDir } = freshDest();
  const bigFile = new FakeTorrentFile("movie.mp4", "movie.mp4", 100);
  const smallFile = new FakeTorrentFile("sample.mp4", "sample.mp4", 5);
  writeFileSync(join(torrentDir, "movie.mp4"), "x".repeat(100));
  const torrent = new FakeTorrent([smallFile, bigFile], torrentDir);
  const client = new FakeClient(torrent);

  const resultPromise = downloadMagnetToPart(MAGNET, destPath, { client });
  await client.whenAdded;

  assert.equal(bigFile.selected, true);
  assert.equal(smallFile.selected, false);

  torrent.emit("done");
  const outcome = await resultPromise;

  assert.deepEqual(outcome, { kind: "complete", bytesTotal: 100, etag: null });
  assert.equal(readFileSync(destPath, "utf8"), "x".repeat(100));
});

test("reports progress via the selected file's downloaded bytes", async () => {
  const { destPath, torrentDir } = freshDest();
  const file = new FakeTorrentFile("movie.mp4", "movie.mp4", 100);
  writeFileSync(join(torrentDir, "movie.mp4"), "x".repeat(100));
  const torrent = new FakeTorrent([file], torrentDir);
  const client = new FakeClient(torrent);

  const progressEvents: [number, number | null][] = [];
  const resultPromise = downloadMagnetToPart(MAGNET, destPath, {
    client,
    onProgress: (downloaded, total) => progressEvents.push([downloaded, total]),
  });
  await client.whenAdded;

  file.downloaded = 40;
  torrent.emit("download");
  file.downloaded = 100;
  torrent.emit("download");
  torrent.emit("done");
  await resultPromise;

  assert.deepEqual(progressEvents, [
    [40, 100],
    [100, 100],
  ]);
});

test("a torrent-level error is a terminal error and destroys the client", async () => {
  const { destPath, torrentDir } = freshDest();
  const file = new FakeTorrentFile("movie.mp4", "movie.mp4", 100);
  const torrent = new FakeTorrent([file], torrentDir);
  const client = new FakeClient(torrent);

  const resultPromise = downloadMagnetToPart(MAGNET, destPath, { client });
  await client.whenAdded;

  torrent.emit("error", "no seeds found");
  const outcome = await resultPromise;

  assert.deepEqual(outcome, { kind: "terminal-error", message: "no seeds found" });
});

test("insufficient disk space pauses the download and destroys the torrent's store", async () => {
  const { destPath, torrentDir } = freshDest();
  const file = new FakeTorrentFile("movie.mp4", "movie.mp4", 100);
  const torrent = new FakeTorrent([file], torrentDir);
  const client = new FakeClient(torrent);

  const outcome = await downloadMagnetToPart(MAGNET, destPath, {
    client,
    checkDiskSpace: async () => false,
  });

  assert.deepEqual(outcome, { kind: "paused-disk-full" });
  assert.equal(torrent.destroyed, true);
  assert.equal(torrent.destroyedWithStore, true);
});

test("aborting mid-download pauses (not fails) and cleans up", async () => {
  const { destPath, torrentDir } = freshDest();
  const file = new FakeTorrentFile("movie.mp4", "movie.mp4", 100);
  const torrent = new FakeTorrent([file], torrentDir);
  const client = new FakeClient(torrent);
  const controller = new AbortController();

  const resultPromise = downloadMagnetToPart(MAGNET, destPath, { client, signal: controller.signal });
  await client.whenAdded;

  controller.abort();
  const outcome = await resultPromise;

  assert.deepEqual(outcome, { kind: "paused-network", message: "shutdown requested" });
  assert.equal(torrent.destroyed, true);
});

test("a torrent with no files is a terminal error", async () => {
  const { destPath, torrentDir } = freshDest();
  const torrent = new FakeTorrent([], torrentDir);
  const client = new FakeClient(torrent);

  const outcome = await downloadMagnetToPart(MAGNET, destPath, { client });
  assert.deepEqual(outcome, { kind: "terminal-error", message: "torrent has no files" });
});
