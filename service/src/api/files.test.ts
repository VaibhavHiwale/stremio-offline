import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { createDbConnection } from "../db/client.js";
import { buildSignedFileUrl, parseRangeHeader, registerFilesRoute } from "./files.js";

const SIZE = 1000;

test("open-ended range: bytes=500-", () => {
  assert.deepEqual(parseRangeHeader("bytes=500-", SIZE), [{ start: 500, end: 999 }]);
});

test("bounded range: bytes=0-499", () => {
  assert.deepEqual(parseRangeHeader("bytes=0-499", SIZE), [{ start: 0, end: 499 }]);
});

test("suffix range: bytes=-100 (last 100 bytes)", () => {
  assert.deepEqual(parseRangeHeader("bytes=-100", SIZE), [{ start: 900, end: 999 }]);
});

test("suffix range larger than file clamps to start of file", () => {
  assert.deepEqual(parseRangeHeader("bytes=-5000", SIZE), [{ start: 0, end: 999 }]);
});

test("end beyond file size clamps to last byte", () => {
  assert.deepEqual(parseRangeHeader("bytes=900-9999", SIZE), [{ start: 900, end: 999 }]);
});

test("multi-range request parses all parts", () => {
  assert.deepEqual(parseRangeHeader("bytes=0-99,200-299,-50", SIZE), [
    { start: 0, end: 99 },
    { start: 200, end: 299 },
    { start: 950, end: 999 },
  ]);
});

test("start beyond file size is unsatisfiable", () => {
  assert.equal(parseRangeHeader("bytes=1000-1100", SIZE), null);
});

test("malformed header returns null", () => {
  assert.equal(parseRangeHeader("bytes=abc-def", SIZE), null);
  assert.equal(parseRangeHeader("nonsense", SIZE), null);
});

function buildTestApp() {
  const dir = mkdtempSync(join(tmpdir(), "stremio-offline-files-subtitle-test-"));
  const db = createDbConnection(join(dir, "db.sqlite"));
  const secret = "test-secret";
  const app = Fastify();
  registerFilesRoute(app, { db, secret });
  return { app, db, secret, dir };
}

test("GET /files/:id?variant=subtitle&lang=xx serves the sidecar .srt for a ready row", async () => {
  const { app, db, secret, dir } = buildTestApp();
  const videoDir = join(dir, "Movies", "The Matrix (1999)");
  const videoPath = join(videoDir, "The Matrix (1999).mp4");
  const srtPath = join(videoDir, "The Matrix (1999).en.srt");
  mkdirSync(videoDir, { recursive: true });
  writeFileSync(videoPath, "fake mp4");

  db.prepare(
    `INSERT INTO download_items
       (id, stremio_id, series_id, type, title, year, season, episode, quality, source_kind, source_url,
        status, storage_target_id, file_path_web_ready, added_at)
     VALUES ('row-1', 'tt0903747', NULL, 'movie', 'The Matrix', 1999, NULL, NULL, '1080p', 'http',
        'https://example.invalid/x', 'ready', 'default', ?, datetime('now'))`,
  ).run(videoPath);

  const srtContent = "1\n00:00:01,000 --> 00:00:02,000\nHello\n";
  writeFileSync(srtPath, srtContent, "utf8");

  const url = buildSignedFileUrl("http://x", secret, "row-1", 60, "subtitle", "en");
  const res = await app.inject({ method: "GET", url: url.replace("http://x", "") });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, srtContent);
  assert.match(res.headers["content-type"] as string, /application\/x-subrip/);
});

test("GET /files/:id?variant=subtitle rejects an invalid lang code", async () => {
  const { app, db, secret, dir } = buildTestApp();
  const videoPath = join(dir, "movie.mp4");
  db.prepare(
    `INSERT INTO download_items
       (id, stremio_id, series_id, type, title, year, season, episode, quality, source_kind, source_url,
        status, storage_target_id, file_path_web_ready, added_at)
     VALUES ('row-1', 'tt1', NULL, 'movie', 'X', 2020, NULL, NULL, '1080p', 'http',
        'https://example.invalid/x', 'ready', 'default', ?, datetime('now'))`,
  ).run(videoPath);

  const url = buildSignedFileUrl("http://x", secret, "row-1", 60, "subtitle", "../../etc/passwd");
  const res = await app.inject({ method: "GET", url: url.replace("http://x", "") });
  assert.equal(res.statusCode, 404);
});

test("GET /files/:id?variant=subtitle 404s when the sidecar was never fetched", async () => {
  const { app, db, secret, dir } = buildTestApp();
  const videoPath = join(dir, "movie.mp4");
  db.prepare(
    `INSERT INTO download_items
       (id, stremio_id, series_id, type, title, year, season, episode, quality, source_kind, source_url,
        status, storage_target_id, file_path_web_ready, added_at)
     VALUES ('row-1', 'tt1', NULL, 'movie', 'X', 2020, NULL, NULL, '1080p', 'http',
        'https://example.invalid/x', 'ready', 'default', ?, datetime('now'))`,
  ).run(videoPath);

  const url = buildSignedFileUrl("http://x", secret, "row-1", 60, "subtitle", "fr");
  const res = await app.inject({ method: "GET", url: url.replace("http://x", "") });
  assert.equal(res.statusCode, 404);
});
