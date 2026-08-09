import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateH264Aac, generateHevcAc3 } from "../testutils/mediaFixtures.js";
import { probeFile } from "./probe.js";
import { runFfmpeg } from "./remux.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "stremio-offline-remux-test-"));
}

test("copy plan on an already H.264/AAC source is fast and produces a playable MP4", async () => {
  const dir = freshDir();
  const input = join(dir, "in.mp4");
  const output = join(dir, "out.mp4");
  await generateH264Aac(input, 1);

  const result = await runFfmpeg(input, output, "copy");

  assert.equal(result.success, true, result.stderrTail);
  assert.ok(statSync(output).size > 0);

  const probed = await probeFile(output);
  assert.equal(probed.videoStream?.codecName, "h264");
  assert.equal(probed.audioStream?.codecName, "aac");
});

test("transcode plan on an HEVC/AC3 source produces H.264/AAC output", async () => {
  const dir = freshDir();
  const input = join(dir, "in.mkv");
  const output = join(dir, "out.mp4");
  await generateHevcAc3(input, 1);

  const result = await runFfmpeg(input, output, "transcode");

  assert.equal(result.success, true, result.stderrTail);
  const probed = await probeFile(output);
  assert.equal(probed.videoStream?.codecName, "h264");
  assert.equal(probed.audioStream?.codecName, "aac");
});

test("a nonexistent input fails cleanly and reports stderr rather than throwing", async () => {
  const dir = freshDir();
  const result = await runFfmpeg(join(dir, "does-not-exist.mkv"), join(dir, "out.mp4"), "copy");
  assert.equal(result.success, false);
  assert.ok(result.stderrTail.length > 0);
});
