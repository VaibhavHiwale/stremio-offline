import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDbConnection } from "../db/client.js";
import { insertSourceAddon } from "../db/sourceAddons.js";
import { triggerAutoDownloadNextEpisodes, type AutoDownloadRow } from "./autoDownload.js";

function freshEnv() {
  const storageRoot = mkdtempSync(join(tmpdir(), "stremio-offline-autodownload-test-"));
  const db = createDbConnection(join(storageRoot, ".offline", "db.sqlite"));
  return { db, storageRoot };
}

function enableAutoDownload(db: ReturnType<typeof createDbConnection>, lookahead = 1) {
  db.prepare("UPDATE settings SET auto_download_next_episode = 1, auto_download_lookahead = ? WHERE id = 1").run(lookahead);
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

const baseRow: AutoDownloadRow = {
  id: "ep-s01e01",
  stremioId: "tt1234567:1:1",
  seriesId: "tt1234567",
  type: "series",
  title: "Test Show",
  season: 1,
  episode: 1,
};

function queuedRows(db: ReturnType<typeof createDbConnection>): { stremioId: string; sourceKind: string; sourceUrl: string; quality: string }[] {
  return db
    .prepare("SELECT stremio_id AS stremioId, source_kind AS sourceKind, source_url AS sourceUrl, quality FROM download_items WHERE id != ?")
    .all(baseRow.id) as { stremioId: string; sourceKind: string; sourceUrl: string; quality: string }[];
}

test("does nothing when autoDownloadNextEpisode is disabled", async () => {
  const { db, storageRoot } = freshEnv();
  insertSourceAddon(db, { id: "a1", manifestUrl: "https://fake.example/manifest.json", name: "Fake" });
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return jsonResponse({});
  }) as unknown as typeof fetch;

  await triggerAutoDownloadNextEpisodes({ db, storageRoot, fetchImpl }, baseRow);
  assert.equal(called, false);
  assert.equal(queuedRows(db).length, 0);
});

test("does nothing for a movie row, even if enabled", async () => {
  const { db, storageRoot } = freshEnv();
  enableAutoDownload(db);
  insertSourceAddon(db, { id: "a1", manifestUrl: "https://fake.example/manifest.json", name: "Fake" });

  await triggerAutoDownloadNextEpisodes(
    { db, storageRoot },
    { ...baseRow, type: "movie", season: null, episode: null },
  );
  assert.equal(queuedRows(db).length, 0);
});

test("does nothing when no source addons are registered", async () => {
  const { db, storageRoot } = freshEnv();
  enableAutoDownload(db);
  await triggerAutoDownloadNextEpisodes({ db, storageRoot }, baseRow);
  assert.equal(queuedRows(db).length, 0);
});

test("enqueues the next episode using the addon's meta videos list, matching the default quality", async () => {
  const { db, storageRoot } = freshEnv();
  enableAutoDownload(db, 1);
  insertSourceAddon(db, { id: "a1", manifestUrl: "https://fake.example/manifest.json", name: "Fake" });

  const fetchImpl = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes("/meta/series/")) {
      return jsonResponse({
        meta: {
          id: "tt1234567",
          videos: [
            { id: "tt1234567:1:1", season: 1, episode: 1, title: "Episode 1" },
            { id: "tt1234567:1:2", season: 1, episode: 2, title: "Episode 2" },
          ],
        },
      });
    }
    if (u.includes("/stream/series/tt1234567%3A1%3A2")) {
      return jsonResponse({ streams: [{ title: "720p release", infoHash: "aaa" }, { title: "1080p release", infoHash: "bbb" }] });
    }
    throw new Error(`unexpected URL: ${u}`);
  }) as unknown as typeof fetch;

  await triggerAutoDownloadNextEpisodes({ db, storageRoot, fetchImpl }, baseRow);

  const rows = queuedRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.stremioId, "tt1234567:1:2");
  assert.equal(rows[0]!.quality, "1080p"); // matches settings.defaultQuality (1080p by default)
  assert.equal(rows[0]!.sourceKind, "magnet"); // no debrid account configured
  assert.ok(rows[0]!.sourceUrl.startsWith("magnet:?xt=urn:btih:bbb"));
});

test("falls back to same-season increment when no registered addon implements meta", async () => {
  const { db, storageRoot } = freshEnv();
  enableAutoDownload(db, 2);
  insertSourceAddon(db, { id: "a1", manifestUrl: "https://fake.example/manifest.json", name: "Fake" });

  const fetchImpl = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes("/meta/series/")) return jsonResponse({}, false, 404);
    if (u.includes("stream/series/tt1234567%3A1%3A2")) return jsonResponse({ streams: [{ title: "1080p", infoHash: "aaa" }] });
    if (u.includes("stream/series/tt1234567%3A1%3A3")) return jsonResponse({ streams: [{ title: "1080p", infoHash: "bbb" }] });
    throw new Error(`unexpected URL: ${u}`);
  }) as unknown as typeof fetch;

  await triggerAutoDownloadNextEpisodes({ db, storageRoot, fetchImpl }, baseRow);

  const rows = queuedRows(db).sort((a, b) => a.stremioId.localeCompare(b.stremioId));
  assert.deepEqual(
    rows.map((r) => r.stremioId),
    ["tt1234567:1:2", "tt1234567:1:3"],
  );
});

test("skips an episode with no matching stream on any registered addon, without erroring", async () => {
  const { db, storageRoot } = freshEnv();
  enableAutoDownload(db, 1);
  insertSourceAddon(db, { id: "a1", manifestUrl: "https://fake.example/manifest.json", name: "Fake" });

  const fetchImpl = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes("/meta/series/")) return jsonResponse({}, false, 404);
    if (u.includes("/stream/series/")) return jsonResponse({ streams: [] });
    throw new Error(`unexpected URL: ${u}`);
  }) as unknown as typeof fetch;

  await triggerAutoDownloadNextEpisodes({ db, storageRoot, fetchImpl }, baseRow);
  assert.equal(queuedRows(db).length, 0);
});

test("never re-enqueues an episode that already has a download_items row", async () => {
  const { db, storageRoot } = freshEnv();
  enableAutoDownload(db, 1);
  insertSourceAddon(db, { id: "a1", manifestUrl: "https://fake.example/manifest.json", name: "Fake" });
  db.prepare(
    `INSERT INTO download_items (id, stremio_id, series_id, type, title, year, season, episode, quality, source_kind, source_url, status, storage_target_id, added_at)
     VALUES ('existing', 'tt1234567:1:2', 'tt1234567', 'series', 'Test Show', NULL, 1, 2, '1080p', 'http', 'https://already.example/x', 'failed', 'default', datetime('now'))`,
  ).run();

  let streamsFetched = false;
  const fetchImpl = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes("/meta/series/")) return jsonResponse({}, false, 404);
    streamsFetched = true;
    return jsonResponse({ streams: [{ title: "1080p", infoHash: "aaa" }] });
  }) as unknown as typeof fetch;

  await triggerAutoDownloadNextEpisodes({ db, storageRoot, fetchImpl }, baseRow);

  assert.equal(streamsFetched, false, "an already-existing row must short-circuit before even querying for streams");
  assert.equal(queuedRows(db).length, 1); // still just the pre-existing row, untouched
});

test("uses sourceKind 'debrid' (not 'magnet') when a debrid account is configured", async () => {
  const { db, storageRoot } = freshEnv();
  enableAutoDownload(db, 1);
  insertSourceAddon(db, { id: "a1", manifestUrl: "https://fake.example/manifest.json", name: "Fake" });
  db.prepare(
    `INSERT INTO debrid_accounts (service, api_key, enabled, added_at) VALUES ('realdebrid', 'key', 1, datetime('now'))`,
  ).run();

  const fetchImpl = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes("/meta/series/")) return jsonResponse({}, false, 404);
    return jsonResponse({ streams: [{ title: "1080p", infoHash: "aaa" }] });
  }) as unknown as typeof fetch;

  await triggerAutoDownloadNextEpisodes({ db, storageRoot, fetchImpl }, baseRow);

  const rows = queuedRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.sourceKind, "debrid");
});

test("a thrown error inside the trigger is recorded, not propagated", async () => {
  const { db, storageRoot } = freshEnv();
  enableAutoDownload(db, 1);
  insertSourceAddon(db, { id: "a1", manifestUrl: "https://fake.example/manifest.json", name: "Fake" });

  const fetchImpl = (async () => {
    throw new Error("total network failure");
  }) as unknown as typeof fetch;

  // fetchStreamsFromAddon/fetchSeriesVideos already swallow fetch errors
  // internally (return [] / null), so to actually exercise autoDownload's
  // own try/catch we make getSettings-adjacent DB access fail instead by
  // closing the db first — this simulates "any unexpected failure", not a
  // specific one.
  db.close();
  await assert.doesNotReject(() => triggerAutoDownloadNextEpisodes({ db, storageRoot, fetchImpl }, baseRow));
});
