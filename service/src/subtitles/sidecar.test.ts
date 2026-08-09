import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sidecarPath, writeSidecar } from "./sidecar.js";

test("computes the sidecar path next to the video, matching the library naming convention", () => {
  const videoPath = join("Movies", "The Matrix (1999)", "The Matrix (1999).mp4");
  assert.equal(sidecarPath(videoPath, "en"), join("Movies", "The Matrix (1999)", "The Matrix (1999).en.srt"));
});

test("rejects an unsafe language code rather than building a path from it", () => {
  assert.throws(() => sidecarPath("movie.mp4", "../../etc/passwd"));
  assert.throws(() => sidecarPath("movie.mp4", ""));
});

test("accepts region-tagged language codes", () => {
  assert.equal(sidecarPath("movie.mp4", "pt-BR"), "movie.pt-BR.srt");
});

test("writeSidecar creates parent directories and writes the content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stremio-offline-sidecar-test-"));
  const path = join(dir, "nested", "movie.en.srt");
  await writeSidecar(path, "1\n00:00:01,000 --> 00:00:02,000\nHi\n");

  assert.equal(existsSync(path), true);
  assert.equal(readFileSync(path, "utf8"), "1\n00:00:01,000 --> 00:00:02,000\nHi\n");
});
