import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDbConnection } from "../db/client.js";
import { upsertDebridAccount } from "../db/debridAccounts.js";
import { getConfiguredResolver } from "./autodetect.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "stremio-offline-autodetect-test-"));
  return createDbConnection(join(dir, "db.sqlite"));
}

test("returns null when nothing is configured", () => {
  const db = freshDb();
  assert.equal(getConfiguredResolver(db), null);
});

test("skips a disabled account", () => {
  const db = freshDb();
  upsertDebridAccount(db, { service: "realdebrid", apiKey: "key1", enabled: false });
  assert.equal(getConfiguredResolver(db), null);
});

test("picks the highest-priority configured service per CLAUDE.md Rule 7's listed order", () => {
  const db = freshDb();
  // Configured out of order — priority should still win, not insertion order.
  upsertDebridAccount(db, { service: "torbox", apiKey: "key-tb", enabled: true });
  upsertDebridAccount(db, { service: "premiumize", apiKey: "key-pm", enabled: true });

  const result = getConfiguredResolver(db)!;
  assert.equal(result.resolver.service, "premiumize", "premiumize outranks torbox in Rule 7's order");
  assert.equal(result.apiKey, "key-pm");
});

test("real-debrid outranks every other configured service", () => {
  const db = freshDb();
  upsertDebridAccount(db, { service: "alldebrid", apiKey: "key-ad", enabled: true });
  upsertDebridAccount(db, { service: "realdebrid", apiKey: "key-rd", enabled: true });

  const result = getConfiguredResolver(db)!;
  assert.equal(result.resolver.service, "realdebrid");
});

test("upsert replaces the key for an existing service rather than duplicating it", () => {
  const db = freshDb();
  upsertDebridAccount(db, { service: "realdebrid", apiKey: "old-key", enabled: true });
  upsertDebridAccount(db, { service: "realdebrid", apiKey: "new-key", enabled: true });

  const result = getConfiguredResolver(db)!;
  assert.equal(result.apiKey, "new-key");

  const count = (db.prepare("SELECT COUNT(*) AS n FROM debrid_accounts").get() as { n: number }).n;
  assert.equal(count, 1);
});
