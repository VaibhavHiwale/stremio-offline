import { createHash } from "node:crypto";
import { createReadStream, promises as fsp } from "node:fs";
import { probeFile } from "./probe.js";

/** Computed as a separate pass over the completed file, not incrementally during a possibly-resumed download — simpler and correct regardless of how many resumes it took to assemble the file. */
export function computeSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export type RemuxVerification = { ok: true } | { ok: false; reason: string };

const DURATION_TOLERANCE = 0.01; // 1% — CLAUDE.md §4 Verification

/**
 * Post-remux check — CLAUDE.md §4: "assert duration is within 1% of the
 * source and at least one video and one audio stream exist. A zero-byte or
 * truncated MP4 that Stremio fails to play is worse than a visible failure."
 */
export async function verifyRemuxOutput(
  outputPath: string,
  sourceDurationSeconds: number,
  ffprobePath?: string,
): Promise<RemuxVerification> {
  let size: number;
  try {
    size = (await fsp.stat(outputPath)).size;
  } catch {
    return { ok: false, reason: "output file does not exist" };
  }
  if (size === 0) return { ok: false, reason: "output file is zero bytes" };

  let probe;
  try {
    probe = await probeFile(outputPath, ffprobePath);
  } catch (err) {
    return { ok: false, reason: `ffprobe failed on output: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!probe.videoStream) return { ok: false, reason: "output has no video stream" };
  if (!probe.audioStream) return { ok: false, reason: "output has no audio stream" };

  if (sourceDurationSeconds > 0) {
    const drift = Math.abs(probe.durationSeconds - sourceDurationSeconds) / sourceDurationSeconds;
    if (drift > DURATION_TOLERANCE) {
      return {
        ok: false,
        reason: `duration drift ${(drift * 100).toFixed(1)}% exceeds 1% tolerance (source ${sourceDurationSeconds}s, output ${probe.durationSeconds}s)`,
      };
    }
  }

  return { ok: true };
}
