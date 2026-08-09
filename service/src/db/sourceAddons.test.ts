import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDbConnection } from "./client.js";
import { deleteSourceAddon, getSourceAddonByManifestUrl, insertSourceAddon, listSourceAddons } from "./sourceAddons.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "stremio-offline-sourceaddons-test-"));
  return createDbConnection(join(dir, "db.sqlite"));
}

test("insert creates a new addon, retrievable by manifest url and in the list", () => {
  const db = freshDb();
  const inserted = insertSourceAddon(db, { id: "a1", manifestUrl: "https://fake.example/manifest.json", name: "Fake Addon" });
  assert.equal(inserted, true);

  const found = getSourceAddonByManifestUrl(db, "https://fake.example/manifest.json")!;
  assert.equal(found.id, "a1");
  assert.equal(found.name, "Fake Addon");

  assert.equal(listSourceAddons(db).length, 1);
});

test("re-inserting the same manifest url is a no-op, not a duplicate row", () => {
  const db = freshDb();
  insertSourceAddon(db, { id: "a1", manifestUrl: "https://fake.example/manifest.json", name: "Fake Addon" });
  const second = insertSourceAddon(db, { id: "a2", manifestUrl: "https://fake.example/manifest.json", name: "Different Name" });

  assert.equal(second, false);
  assert.equal(listSourceAddons(db).length, 1);
  assert.equal(listSourceAddons(db)[0]!.name, "Fake Addon"); // first registration wins, not overwritten
});

test("listSourceAddons is ordered by registration time", () => {
  const db = freshDb();
  insertSourceAddon(db, { id: "a1", manifestUrl: "https://first.example/manifest.json", name: "First" });
  insertSourceAddon(db, { id: "a2", manifestUrl: "https://second.example/manifest.json", name: "Second" });

  const names = listSourceAddons(db).map((a) => a.name);
  assert.deepEqual(names, ["First", "Second"]);
});

test("delete removes the row and is idempotent", () => {
  const db = freshDb();
  insertSourceAddon(db, { id: "a1", manifestUrl: "https://fake.example/manifest.json", name: "Fake Addon" });

  assert.equal(deleteSourceAddon(db, "a1"), true);
  assert.equal(listSourceAddons(db).length, 0);
  assert.equal(deleteSourceAddon(db, "a1"), false);
});
