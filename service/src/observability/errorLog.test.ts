import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { errorLogPath, readRecentErrors, recordError } from "./errorLog.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "stremio-offline-errorlog-test-"));
}

test("appends one NDJSON line per call, creating parent directories as needed", () => {
  const dir = freshDir();
  recordError(dir, "scheduler", new Error("boom"), { installIdHash: "abc123" });
  recordError(dir, "remuxRunner", new Error("kaboom"), { installIdHash: "abc123" });

  const lines = readFileSync(errorLogPath(dir), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]!);
  assert.equal(first.component, "scheduler");
  assert.equal(first.message, "boom");
  assert.equal(first.errorType, "Error");
  assert.equal(first.installIdHash, "abc123");
  assert.ok(first.timestamp);
  assert.ok(first.stack);
});

test("captures requestPath when supplied", () => {
  const dir = freshDir();
  recordError(dir, "rest", new Error("bad request"), { requestPath: "/downloads/abc", installIdHash: "x" });
  const record = JSON.parse(readFileSync(errorLogPath(dir), "utf8").trim());
  assert.equal(record.requestPath, "/downloads/abc");
});

test("handles a non-Error thrown value without crashing", () => {
  const dir = freshDir();
  recordError(dir, "resolver:realdebrid", "just a string", { installIdHash: "x" });
  const record = JSON.parse(readFileSync(errorLogPath(dir), "utf8").trim());
  assert.equal(record.errorType, "UnknownError");
  assert.equal(record.message, "just a string");
});

test("readRecentErrors filters by cutoff and skips corrupted lines", () => {
  const dir = freshDir();
  recordError(dir, "scheduler", new Error("recent"), { installIdHash: "x" });

  const path = errorLogPath(dir);
  appendFileSync(path, "not valid json\n");
  appendFileSync(
    path,
    `${JSON.stringify({ timestamp: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), component: "old", errorType: "Error", message: "ancient", installIdHash: "x" })}\n`,
  );

  const recent = readRecentErrors(dir, 7 * 24 * 60 * 60 * 1000);
  assert.equal(recent.length, 1);
  assert.equal(recent[0]!.message, "recent");
});

test("readRecentErrors returns an empty array when no log file exists yet", () => {
  const dir = freshDir();
  assert.deepEqual(readRecentErrors(dir, 1000), []);
});

test("recordError never throws even if given a nonsense storage root", () => {
  assert.doesNotThrow(() => {
    // A path a normal process can't create (null byte) — recordError must swallow this internally.
    recordError("\0invalid\0path", "scheduler", new Error("x"), { installIdHash: "x" });
  });
});
