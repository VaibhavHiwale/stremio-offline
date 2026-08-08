import type { ProbeResult } from "./probe.js";

export type RemuxPlan = "copy" | "transcode";

const TEN_BIT_PIX_FMT = /10le$|10be$|p010/i;

/**
 * CLAUDE.md §3 Rule 1: H.264/AAC in MKV → lossless copy-remux (just the
 * container + faststart). Anything else — HEVC, 10-bit, AC3, DTS, VC-1 — →
 * full transcode of both streams. Deliberately binary, not per-stream: a
 * mixed case (e.g. compliant video + DTS audio) still gets a full
 * transcode rather than a partial copy, per the spec's explicit list.
 */
export function decideRemuxPlan(probe: ProbeResult): { plan: RemuxPlan; reason: string } {
  if (!probe.videoStream) return { plan: "transcode", reason: "no video stream found" };
  if (!probe.audioStream) return { plan: "transcode", reason: "no audio stream found" };

  const video = probe.videoStream;
  const audio = probe.audioStream;

  if (video.codecName !== "h264") {
    return { plan: "transcode", reason: `video codec ${video.codecName} is not H.264` };
  }
  if (video.pixFmt && TEN_BIT_PIX_FMT.test(video.pixFmt)) {
    return { plan: "transcode", reason: `10-bit pixel format ${video.pixFmt}` };
  }
  if (audio.codecName !== "aac") {
    return { plan: "transcode", reason: `audio codec ${audio.codecName} is not AAC` };
  }

  return { plan: "copy", reason: "already H.264/AAC" };
}
