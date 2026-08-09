import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpegBinaryPathRaw from "ffmpeg-static";

const execFileAsync = promisify(execFile);
const ffmpegBinaryPath = ffmpegBinaryPathRaw as unknown as string;

/** Generates a synthetic H.264/AAC MP4 with no real media file needed — the copy-remux path. */
export async function generateH264Aac(outputPath: string, durationSeconds = 1): Promise<void> {
  await execFileAsync(ffmpegBinaryPath, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=320x240:duration=${durationSeconds}:rate=10`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=1000:duration=${durationSeconds}`,
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    outputPath,
  ]);
}

/** Generates a synthetic HEVC/AC3 MKV — forces the transcode path per CLAUDE.md §3 Rule 1. */
export async function generateHevcAc3(outputPath: string, durationSeconds = 1): Promise<void> {
  await execFileAsync(ffmpegBinaryPath, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=320x240:duration=${durationSeconds}:rate=10`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=1000:duration=${durationSeconds}`,
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx265",
    "-c:a",
    "ac3",
    outputPath,
  ]);
}
