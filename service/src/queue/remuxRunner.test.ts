import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDbConnection } from "../db/client.js";
import { getById } from "../db/downloadItems.js";
import { generateH264Aac, generateHevcAc3 } from "../testutils/mediaFixtures.js";
import { computeLibraryPath } from "../storage/libraryPath.js";
import { remuxTempPath } from "../storage/paths.js";
import { processRemuxRow } from "./remuxRunner.js";

function freshEnv() {
  const storageRoot = mkdtempSync(join(tmpdir(), "stremio-offline-remuxrunner-test-"));
  const db = createDbConnection(join(storageRoot, ".offline", "db.sqlite"));
  return { db, storageRoot };
}

function getFullRow(
  db: ReturnType<typeof createDbConnection>,
  id: string,
): { status: string; filePathWebReady: string | null } {
  return db
    .prepare("SELECT status, file_path_web_ready AS filePathWebReady FROM download_items WHERE id = ?")
    .get(id) as { status: string; filePathWebReady: string | null };
}

function insertRemuxingRow(
  db: ReturnType<typeof createDbConnection>,
  row: { id: string; title: string; filePathOriginal: string; type?: "movie" | "series"; season?: number | null; episode?: number | null },
) {
  db.prepare(
    `INSERT INTO download_items
       (id, stremio_id, series_id, type, title, year, season, episode, quality, source_kind, source_url,
        status, storage_target_id, file_path_original, added_at)
     VALUES (?, ?, NULL, ?, ?, 2020, ?, ?, '1080p', 'http', 'https://example.invalid/x',
        'remuxing', 'default', ?, datetime('now'))`,
  ).run(
    row.id,
    row.id,
    row.type ?? "movie",
    row.title,
    row.season ?? null,
    row.episode ?? null,
    row.filePathOriginal,
  );
}

test("copy-remux path: H.264/AAC source lands in the library, not the remux staging dir", async () => {
  const { db, storageRoot } = freshEnv();
  const original = join(storageRoot, "downloaded.mp4");
  await generateH264Aac(original, 1);
  insertRemuxingRow(db, { id: "movie-1", title: "The Matrix", filePathOriginal: original });

  await processRemuxRow({ db, storageRoot }, getById(db, "movie-1")!);

  const row = getFullRow(db, "movie-1");
  assert.equal(row.status, "ready");
  const expectedPath = computeLibraryPath(storageRoot, { type: "movie", title: "The Matrix", year: 2020, season: null, episode: null });
  assert.equal(row.filePathWebReady, expectedPath);
  assert.ok(existsSync(expectedPath), "web-ready file must exist in the library path");
  assert.equal(existsSync(remuxTempPath(storageRoot, "movie-1")), false, "staging file must be renamed away, not left behind");
});

test("transcode path: HEVC/AC3 source is converted to H.264/AAC and published", async () => {
  const { db, storageRoot } = freshEnv();
  const original = join(storageRoot, "downloaded.mkv");
  // A longer clip than the other fixtures: at 1s, encoder frame-boundary
  // rounding alone can exceed the 1% duration-drift tolerance and make this
  // test flaky for a reason that has nothing to do with the code under test.
  await generateHevcAc3(original, 5);
  insertRemuxingRow(db, { id: "movie-2", title: "HEVC Title", filePathOriginal: original });

  await processRemuxRow({ db, storageRoot }, getById(db, "movie-2")!);

  const row = getFullRow(db, "movie-2");
  assert.equal(row.status, "ready");
  assert.ok(row.filePathWebReady && existsSync(row.filePathWebReady));
});

test("a corrupted/truncated input fails cleanly: row marked failed, no partial file left in the library", async () => {
  const { db, storageRoot } = freshEnv();
  const original = join(storageRoot, "corrupt.mp4");
  writeFileSync(original, Buffer.from("not actually a video file"));
  insertRemuxingRow(db, { id: "movie-3", title: "Corrupt Title", filePathOriginal: original });

  await processRemuxRow({ db, storageRoot }, getById(db, "movie-3")!);

  const row = getFullRow(db, "movie-3");
  assert.equal(row.status, "failed");
  assert.equal(row.filePathWebReady, null);
  const expectedPath = computeLibraryPath(storageRoot, { type: "movie", title: "Corrupt Title", year: 2020, season: null, episode: null });
  assert.equal(existsSync(expectedPath), false, "no partial/failed output should ever land in the library path");
});

test("a row with no file_path_original recorded fails immediately without touching ffmpeg", async () => {
  const { db, storageRoot } = freshEnv();
  db.prepare(
    `INSERT INTO download_items
       (id, stremio_id, series_id, type, title, year, season, episode, quality, source_kind, source_url,
        status, storage_target_id, added_at)
     VALUES ('movie-4', 'movie-4', NULL, 'movie', 'No File', 2020, NULL, NULL, '1080p', 'http',
        'https://example.invalid/x', 'remuxing', 'default', datetime('now'))`,
  ).run();

  await processRemuxRow({ db, storageRoot }, getById(db, "movie-4")!);

  assert.equal(getFullRow(db, "movie-4").status, "failed");
});
