import { spawnSync } from "node:child_process";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import type { HealthReport, SubsystemStatus } from "@stremio-offline/shared";
import type { Database } from "better-sqlite3";
import ffmpegBinaryPathRaw from "ffmpeg-static";
import { getFreeBytes } from "../storage/diskspace.js";

const ffmpegBinaryPath = ffmpegBinaryPathRaw as unknown as string | null;

async function checkDisk(storageRoot: string): Promise<{ status: SubsystemStatus; freeBytes: number | null }> {
  const freeBytes = await getFreeBytes(storageRoot);
  if (freeBytes === null) {
    // statfs is unavailable on some platforms (e.g. Windows) — non-fatal, just unknown.
    return { status: "degraded", freeBytes: null };
  }
  return { status: freeBytes > 0 ? "ok" : "degraded", freeBytes };
}

function checkDb(db: Database): SubsystemStatus {
  try {
    db.prepare("SELECT 1").get();
    return "ok";
  } catch {
    return "down";
  }
}

/**
 * Uses the bundled ffmpeg-static / @ffprobe-installer binaries rather than a
 * system PATH lookup — CLAUDE.md §5: "never assume a system ffmpeg exists."
 */
function checkFfmpeg(): SubsystemStatus {
  if (!ffmpegBinaryPath) return "down";
  try {
    const ffmpegResult = spawnSync(ffmpegBinaryPath, ["-version"], { timeout: 3000 });
    const ffprobeResult = spawnSync(ffprobeInstaller.path, ["-version"], { timeout: 3000 });
    return ffmpegResult.status === 0 && ffprobeResult.status === 0 ? "ok" : "down";
  } catch {
    return "down";
  }
}

export interface HealthDeps {
  db: Database;
  storageRoot: string;
  activeJobs: number;
  certStatus: SubsystemStatus;
  certExpiresAt: string | null;
  debridStatus: SubsystemStatus;
}

export async function buildHealthReport(deps: HealthDeps): Promise<HealthReport> {
  const dbStatus = checkDb(deps.db);
  const disk = await checkDisk(deps.storageRoot);
  const ffmpegStatus = checkFfmpeg();

  // Cert/ffmpeg/debrid are expected "down" until P1/P4/P6 land — they're reported for
  // diagnostics but don't fail the overall status until those phases are built.
  const overall: SubsystemStatus = dbStatus === "down" || disk.status === "down" ? "down" : "ok";

  return {
    status: overall,
    timestamp: new Date().toISOString(),
    subsystems: {
      db: dbStatus,
      disk: disk.status,
      diskFreeBytes: disk.freeBytes,
      cert: deps.certStatus,
      certExpiresAt: deps.certExpiresAt,
      activeJobs: deps.activeJobs,
      ffmpeg: ffmpegStatus,
      debrid: deps.debridStatus,
    },
  };
}
