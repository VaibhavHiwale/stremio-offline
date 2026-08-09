import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getInstallIdHash } from "./installId.js";

test("is stable across calls for the same storage root", () => {
  const dir = mkdtempSync(join(tmpdir(), "stremio-offline-installid-test-"));
  const first = getInstallIdHash(dir);
  const second = getInstallIdHash(dir);
  assert.equal(first, second);
});

test("differs across storage roots (different install)", () => {
  const dirA = mkdtempSync(join(tmpdir(), "stremio-offline-installid-test-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "stremio-offline-installid-test-b-"));
  assert.notEqual(getInstallIdHash(dirA), getInstallIdHash(dirB));
});

test("is a hex-encoded SHA-256 hash, not the raw id", () => {
  const dir = mkdtempSync(join(tmpdir(), "stremio-offline-installid-test-"));
  const hash = getInstallIdHash(dir);
  assert.match(hash, /^[0-9a-f]{64}$/);
});
