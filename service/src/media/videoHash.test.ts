import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { computeVideoHash } from "./videoHash.js";

function tempFile(name: string, content: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "stremio-offline-videohash-test-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

test("returns null for a file smaller than 128KB — the reference algorithm has no defined behavior below that size", async () => {
  const path = tempFile("small.mp4", Buffer.alloc(1024));
  assert.equal(await computeVideoHash(path), null);
});

test("a zero-filled file of exactly 2*64KB hashes to its own size (both chunks sum to zero)", async () => {
  const path = tempFile("zeros.mp4", Buffer.alloc(65536 * 2));
  const hash = await computeVideoHash(path);
  assert.equal(hash, (131072).toString(16).padStart(16, "0"));
});

test("changing a byte in the head chunk changes the hash", async () => {
  const size = 65536 * 3;
  const base = Buffer.alloc(size);
  const basePath = tempFile("base.mp4", base);
  const baseHash = await computeVideoHash(basePath);

  const modified = Buffer.from(base);
  modified[10] = 0xff;
  const modifiedPath = tempFile("modified-head.mp4", modified);
  const modifiedHash = await computeVideoHash(modifiedPath);

  assert.notEqual(baseHash, modifiedHash);
});

test("changing a byte in the tail chunk changes the hash", async () => {
  const size = 65536 * 3;
  const base = Buffer.alloc(size);
  const basePath = tempFile("base2.mp4", base);
  const baseHash = await computeVideoHash(basePath);

  const modified = Buffer.from(base);
  modified[size - 10] = 0xff;
  const modifiedPath = tempFile("modified-tail.mp4", modified);
  const modifiedHash = await computeVideoHash(modifiedPath);

  assert.notEqual(baseHash, modifiedHash);
});

test("changing a byte strictly in the middle (outside both 64KB chunks) doesn't change the hash", async () => {
  const size = 65536 * 4; // large enough that the middle is untouched by either chunk
  const base = Buffer.alloc(size);
  const basePath = tempFile("base3.mp4", base);
  const baseHash = await computeVideoHash(basePath);

  const modified = Buffer.from(base);
  modified[size / 2] = 0xff;
  const modifiedPath = tempFile("modified-middle.mp4", modified);
  const modifiedHash = await computeVideoHash(modifiedPath);

  assert.equal(baseHash, modifiedHash);
});

test("is deterministic — computing twice on the same file gives the same hash", async () => {
  const path = tempFile("repeat.mp4", Buffer.from("x".repeat(65536 * 2 + 100)));
  const first = await computeVideoHash(path);
  const second = await computeVideoHash(path);
  assert.equal(first, second);
  assert.equal(first?.length, 16);
});
