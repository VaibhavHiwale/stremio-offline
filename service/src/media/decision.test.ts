import assert from "node:assert/strict";
import { test } from "node:test";
import { decideRemuxPlan } from "./decision.js";
import type { ProbeResult, StreamProbe } from "./probe.js";

function stream(overrides: Partial<StreamProbe> & { codecType: string }): StreamProbe {
  return { codecName: "unknown", pixFmt: null, width: null, height: null, ...overrides };
}

function probe(video: StreamProbe | null, audio: StreamProbe | null): ProbeResult {
  const streams = [video, audio].filter((s): s is StreamProbe => s !== null);
  return { durationSeconds: 100, streams, videoStream: video, audioStream: audio };
}

test("H.264/AAC, 8-bit, is a lossless copy", () => {
  const result = decideRemuxPlan(
    probe(stream({ codecType: "video", codecName: "h264", pixFmt: "yuv420p" }), stream({ codecType: "audio", codecName: "aac" })),
  );
  assert.equal(result.plan, "copy");
});

test("HEVC video forces a transcode even with AAC audio", () => {
  const result = decideRemuxPlan(
    probe(stream({ codecType: "video", codecName: "hevc", pixFmt: "yuv420p" }), stream({ codecType: "audio", codecName: "aac" })),
  );
  assert.equal(result.plan, "transcode");
});

test("10-bit H.264 forces a transcode despite the codec matching", () => {
  const result = decideRemuxPlan(
    probe(stream({ codecType: "video", codecName: "h264", pixFmt: "yuv420p10le" }), stream({ codecType: "audio", codecName: "aac" })),
  );
  assert.equal(result.plan, "transcode");
});

test("H.264 video with DTS audio is a full transcode, not a partial copy", () => {
  const result = decideRemuxPlan(
    probe(stream({ codecType: "video", codecName: "h264", pixFmt: "yuv420p" }), stream({ codecType: "audio", codecName: "dts" })),
  );
  assert.equal(result.plan, "transcode");
});

test("missing video stream is a transcode (there's nothing to copy)", () => {
  const result = decideRemuxPlan(probe(null, stream({ codecType: "audio", codecName: "aac" })));
  assert.equal(result.plan, "transcode");
});

test("missing audio stream is a transcode", () => {
  const result = decideRemuxPlan(probe(stream({ codecType: "video", codecName: "h264", pixFmt: "yuv420p" }), null));
  assert.equal(result.plan, "transcode");
});
