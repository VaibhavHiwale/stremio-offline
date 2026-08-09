import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDbConnection } from "./client.js";
import { getSettings, updateSettings } from "./settings.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "stremio-offline-settings-test-"));
  return createDbConnection(join(dir, "db.sqlite"));
}

test("getSettings returns the schema defaults on a fresh database", () => {
  const db = freshDb();
  const settings = getSettings(db);

  assert.equal(settings.wifiOnly, false);
  assert.equal(settings.defaultQuality, "1080p");
  assert.equal(settings.maxConcurrentDownloads, 2);
  assert.equal(settings.maxConcurrentRemuxes, 1);
  assert.deepEqual(settings.subtitleLangs, ["en"]);
  assert.equal(settings.openSubtitlesApiKey, null);
  assert.equal(settings.defaultStorageTargetId, "default", "falls back to 'default' when the column is NULL");
});

test("updateSettings changes only the given fields", () => {
  const db = freshDb();
  const updated = updateSettings(db, { maxConcurrentDownloads: 5, wifiOnly: true });

  assert.equal(updated.maxConcurrentDownloads, 5);
  assert.equal(updated.wifiOnly, true);
  assert.equal(updated.defaultQuality, "1080p", "untouched fields keep their previous value");

  assert.deepEqual(getSettings(db), updated, "a subsequent read matches what updateSettings returned");
});

test("updateSettings serializes subtitleLangs as JSON and round-trips it correctly", () => {
  const db = freshDb();
  const updated = updateSettings(db, { subtitleLangs: ["en", "fr", "de"] });
  assert.deepEqual(updated.subtitleLangs, ["en", "fr", "de"]);
});

test("updateSettings with an empty patch is a harmless no-op", () => {
  const db = freshDb();
  const before = getSettings(db);
  const after = updateSettings(db, {});
  assert.deepEqual(before, after);
});

test("updateSettings ignores unknown fields rather than erroring", () => {
  const db = freshDb();
  const updated = updateSettings(db, { ...({ notARealField: "x" } as unknown as Record<string, unknown>) });
  assert.equal(updated.maxConcurrentDownloads, 2);
});
