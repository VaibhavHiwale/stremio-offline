import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateH264Aac, generateHevcAc3 } from "../testutils/mediaFixtures.js";
import { probeFile } from "./probe.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "stremio-offline-probe-test-"));
}

test("probes an H.264/AAC file and reports both streams with duration", async () => {
  const dir = freshDir();
  const file = join(dir, "in.mp4");
  await generateH264Aac(file, 1);

  const result = await probeFile(file);

  assert.equal(result.videoStream?.codecType, "video");
  assert.equal(result.videoStream?.codecName, "h264");
  assert.equal(result.audioStream?.codecType, "audio");
  assert.equal(result.audioStream?.codecName, "aac");
  assert.ok(result.durationSeconds > 0.5 && result.durationSeconds < 1.5, `duration ${result.durationSeconds} out of range`);
});

test("probes an HEVC/AC3 file and reports the real codecs, not a guess from the extension", async () => {
  const dir = freshDir();
  const file = join(dir, "in.mkv");
  await generateHevcAc3(file, 1);

  const result = await probeFile(file);

  assert.equal(result.videoStream?.codecName, "hevc");
  assert.equal(result.audioStream?.codecName, "ac3");
});
