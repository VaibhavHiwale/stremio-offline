import { spawn } from "node:child_process";
import ffmpegBinaryPath from "ffmpeg-static";
import type { RemuxPlan } from "./decision.js";

export interface RemuxOutcome {
  success: boolean;
  /** Last ~8KB of stderr — enough to diagnose a failure without unbounded memory growth on a long transcode. */
  stderrTail: string;
}

function buildArgs(inputPath: string, outputPath: string, plan: RemuxPlan): string[] {
  const common = ["-y", "-i", inputPath];
  if (plan === "copy") {
    // Lossless — CLAUDE.md §3 Rule 1: seconds, not minutes.
    return [...common, "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-movflags", "+faststart", outputPath];
  }
  return [
    ...common,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    outputPath,
  ];
}

const MAX_STDERR_LENGTH = 8000;

export function runFfmpeg(
  inputPath: string,
  outputPath: string,
  plan: RemuxPlan,
  opts: { ffmpegPath?: string; signal?: AbortSignal } = {},
): Promise<RemuxOutcome> {
  const bin = opts.ffmpegPath ?? ffmpegBinaryPath;
  if (!bin) {
    return Promise.resolve({ success: false, stderrTail: "no ffmpeg binary available for this platform" });
  }

  const args = buildArgs(inputPath, outputPath, plan);

  return new Promise((resolve) => {
    const spawnOpts: Parameters<typeof spawn>[2] = {};
    if (opts.signal) spawnOpts.signal = opts.signal;

    const proc = spawn(bin, args, spawnOpts);
    let stderr = "";

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > MAX_STDERR_LENGTH) stderr = stderr.slice(-MAX_STDERR_LENGTH);
    });

    proc.on("error", (err) => resolve({ success: false, stderrTail: err.message }));
    proc.on("close", (code) => resolve({ success: code === 0, stderrTail: stderr }));
  });
}
