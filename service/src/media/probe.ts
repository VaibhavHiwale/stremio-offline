import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";

const execFileAsync = promisify(execFile);

export interface StreamProbe {
  codecType: string;
  codecName: string;
  pixFmt: string | null;
  width: number | null;
  height: number | null;
}

export interface ProbeResult {
  durationSeconds: number;
  streams: StreamProbe[];
  videoStream: StreamProbe | null;
  audioStream: StreamProbe | null;
}

interface FfprobeStreamJson {
  codec_type?: string;
  codec_name?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  duration?: string;
}

interface FfprobeOutputJson {
  streams?: FfprobeStreamJson[];
  format?: { duration?: string };
}

/**
 * Probes a media file with ffprobe — CLAUDE.md §3 Rule 1: "Probe first ...
 * decide per-stream, never guess from the file extension."
 */
export async function probeFile(filePath: string, ffprobePath: string = ffprobeInstaller.path): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(ffprobePath, [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    filePath,
  ]);

  const parsed = JSON.parse(stdout) as FfprobeOutputJson;
  const streams: StreamProbe[] = (parsed.streams ?? []).map((s) => ({
    codecType: s.codec_type ?? "unknown",
    codecName: s.codec_name ?? "unknown",
    pixFmt: s.pix_fmt ?? null,
    width: s.width ?? null,
    height: s.height ?? null,
  }));

  const formatDuration = parsed.format?.duration ? Number(parsed.format.duration) : null;
  const streamDurations = streams
    .map((s, i) => Number(parsed.streams?.[i]?.duration))
    .filter((d) => Number.isFinite(d));
  const durationSeconds = formatDuration ?? (streamDurations.length > 0 ? Math.max(...streamDurations) : 0);

  return {
    durationSeconds,
    streams,
    videoStream: streams.find((s) => s.codecType === "video") ?? null,
    audioStream: streams.find((s) => s.codecType === "audio") ?? null,
  };
}
