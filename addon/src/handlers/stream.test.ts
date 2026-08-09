import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { registerStreamRoutes } from "./stream.js";

// Minimal inline schema — mirrors subtitles.test.ts's approach: just the
// columns repository.ts's queries touch, not the real service/db/schema.sql.
function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE download_items (
      id TEXT PRIMARY KEY,
      stremio_id TEXT NOT NULL,
      series_id TEXT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      year INTEGER,
      season INTEGER,
      episode INTEGER,
      quality TEXT NOT NULL,
      status TEXT NOT NULL,
      progress_pct REAL NOT NULL DEFAULT 0,
      bytes_downloaded INTEGER NOT NULL DEFAULT 0,
      bytes_total INTEGER,
      speed_bps REAL,
      eta_seconds INTEGER,
      file_path_original TEXT,
      file_path_web_ready TEXT,
      video_hash TEXT,
      video_size INTEGER,
      subtitle_langs TEXT NOT NULL DEFAULT '[]',
      priority INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL
    );
  `);
  return db;
}

function buildTestApp(db: Database.Database) {
  const app = Fastify();
  registerStreamRoutes(app, {
    db,
    isLegalAccepted: () => true,
    buildFileUrl: (_req, downloadItemId) => `https://example.test/files/${downloadItemId}`,
    buildOriginalFileUrl: (_req, downloadItemId) => `https://example.test/files/${downloadItemId}?variant=original`,
  });
  return app;
}

test("a ready row's behaviorHints carry the real file's basename, not the display title", async () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO download_items (id, stremio_id, type, title, quality, status, file_path_web_ready, video_hash, video_size, added_at)
     VALUES ('row-1', 'tt0903747', 'movie', 'The Matrix', '1080p', 'ready', '/library/Movies/The Matrix (1999)/The Matrix (1999).mp4', 'deadbeefcafef00d', 123456789, datetime('now'))`,
  ).run();
  const app = buildTestApp(db);

  const res = await app.inject({ method: "GET", url: "/stream/movie/tt0903747.json" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { streams: { behaviorHints?: { filename?: string; videoHash?: string; videoSize?: number } }[] };
  const hints = body.streams[0]!.behaviorHints!;
  assert.equal(hints.filename, "The Matrix (1999).mp4");
  assert.equal(hints.videoHash, "deadbeefcafef00d");
  assert.equal(hints.videoSize, 123456789);
});

test("videoHash/videoSize are omitted (not sent as null) when the row has none recorded", async () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO download_items (id, stremio_id, type, title, quality, status, file_path_web_ready, added_at)
     VALUES ('row-1', 'tt0903747', 'movie', 'Tiny Clip', '1080p', 'ready', '/library/tiny.mp4', datetime('now'))`,
  ).run();
  const app = buildTestApp(db);

  const res = await app.inject({ method: "GET", url: "/stream/movie/tt0903747.json" });
  const body = res.json() as { streams: { behaviorHints?: Record<string, unknown> }[] };
  const hints = body.streams[0]!.behaviorHints!;
  assert.equal(hints.filename, "tiny.mp4");
  assert.equal("videoHash" in hints, false);
  assert.equal("videoSize" in hints, false);
});

test("falls back to the display title as filename if somehow file_path_web_ready is missing on a ready row", async () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO download_items (id, stremio_id, type, title, quality, status, added_at)
     VALUES ('row-1', 'tt0903747', 'movie', 'No File Path', '1080p', 'ready', datetime('now'))`,
  ).run();
  const app = buildTestApp(db);

  const res = await app.inject({ method: "GET", url: "/stream/movie/tt0903747.json" });
  const body = res.json() as { streams: { behaviorHints?: { filename?: string } }[] };
  assert.equal(body.streams[0]!.behaviorHints!.filename, "No File Path");
});
