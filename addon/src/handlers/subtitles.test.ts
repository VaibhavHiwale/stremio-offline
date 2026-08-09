import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { registerSubtitlesRoutes } from "./subtitles.js";

// Minimal inline schema — just the columns repository.ts's queries touch.
// Not the real service/db/schema.sql (the addon package doesn't depend on
// the service package), but accurate to it for the columns that matter here.
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
      subtitle_langs TEXT NOT NULL DEFAULT '[]',
      priority INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL
    );
  `);
  return db;
}

function insertReadyRow(db: Database.Database, row: { id: string; stremioId: string; subtitleLangs: string[] }) {
  db.prepare(
    `INSERT INTO download_items
       (id, stremio_id, type, title, quality, status, file_path_web_ready, subtitle_langs, added_at)
     VALUES (?, ?, 'movie', 'Title', '1080p', 'ready', '/library/movie.mp4', ?, datetime('now'))`,
  ).run(row.id, row.stremioId, JSON.stringify(row.subtitleLangs));
}

function buildTestApp(db: Database.Database) {
  const app = Fastify();
  registerSubtitlesRoutes(app, {
    db,
    buildSubtitleUrl: (_req, downloadItemId, lang) => `https://example.test/files/${downloadItemId}?variant=subtitle&lang=${lang}`,
  });
  return app;
}

test("returns one entry per fetched language for a ready row", async () => {
  const db = freshDb();
  insertReadyRow(db, { id: "row-1", stremioId: "tt0903747", subtitleLangs: ["en", "fr"] });
  const app = buildTestApp(db);

  const res = await app.inject({ method: "GET", url: "/subtitles/movie/tt0903747.json" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { subtitles: { id: string; url: string; lang: string }[] };
  assert.equal(body.subtitles.length, 2);
  assert.deepEqual(
    body.subtitles.map((s) => s.lang).sort(),
    ["en", "fr"],
  );
  assert.ok(body.subtitles.every((s) => s.url.includes("row-1")));
});

test("returns an empty list when no subtitles have been fetched yet", async () => {
  const db = freshDb();
  insertReadyRow(db, { id: "row-1", stremioId: "tt0903747", subtitleLangs: [] });
  const app = buildTestApp(db);

  const res = await app.inject({ method: "GET", url: "/subtitles/movie/tt0903747.json" });
  assert.deepEqual(res.json(), { subtitles: [] });
});

test("returns an empty list for an unknown stremioId (protocol-valid empty response, not a 404)", async () => {
  const db = freshDb();
  const app = buildTestApp(db);

  const res = await app.inject({ method: "GET", url: "/subtitles/movie/tt9999999.json" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { subtitles: [] });
});

test("skips rows that aren't ready yet", async () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO download_items (id, stremio_id, type, title, quality, status, subtitle_langs, added_at)
     VALUES ('row-1', 'tt0903747', 'movie', 'Title', '1080p', 'downloading', '["en"]', datetime('now'))`,
  ).run();
  const app = buildTestApp(db);

  const res = await app.inject({ method: "GET", url: "/subtitles/movie/tt0903747.json" });
  assert.deepEqual(res.json(), { subtitles: [] });
});

test("also mounts under the /:config prefix", async () => {
  const db = freshDb();
  insertReadyRow(db, { id: "row-1", stremioId: "tt0903747", subtitleLangs: ["en"] });
  const app = buildTestApp(db);

  const res = await app.inject({ method: "GET", url: "/some-config/subtitles/movie/tt0903747.json" });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as { subtitles: unknown[] }).subtitles.length, 1);
});
