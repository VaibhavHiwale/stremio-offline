import { promises as fsp } from "node:fs";
import { cpus } from "node:os";
import { dirname } from "node:path";
import type { Database } from "better-sqlite3";
import { addSubtitleLang, getRemuxingRows, markFailed, markReady, type QueueRow } from "../db/downloadItems.js";
import { getDefaultSubtitleLangs, getOpenSubtitlesApiKey } from "../db/settings.js";
import { decideRemuxPlan } from "../media/decision.js";
import { probeFile } from "../media/probe.js";
import { runFfmpeg } from "../media/remux.js";
import { verifyRemuxOutput } from "../media/verify.js";
import { computeVideoHash } from "../media/videoHash.js";
import { recordError } from "../observability/errorLog.js";
import { triggerAutoDownloadNextEpisodes } from "./autoDownload.js";
import { computeLibraryPath } from "../storage/libraryPath.js";
import { remuxTempPath } from "../storage/paths.js";
import { fetchSubtitlesForItem } from "../subtitles/fetchForItem.js";
import { sleep } from "../util/backoff.js";
import { Semaphore } from "./semaphore.js";

export interface RemuxRunnerDeps {
  db: Database;
  storageRoot: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  /** Injectable for tests — subtitles (P7) default to the real OpenSubtitles API. */
  subtitlesBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /** For correlating error records — defaults to "unknown" so tests don't need to supply one. */
  installIdHash?: string;
  signal?: AbortSignal;
}

/**
 * Best-effort subtitle fetch after a successful publish — CLAUDE.md §3
 * Rule 9. Never affects the download's `ready` status: skipped silently
 * when no OpenSubtitles key is configured, and any per-language failure
 * inside fetchSubtitlesForItem is already swallowed there.
 */
async function fetchSubtitlesBestEffort(deps: RemuxRunnerDeps, row: QueueRow, videoPath: string): Promise<void> {
  const apiKey = getOpenSubtitlesApiKey(deps.db);
  if (!apiKey) return;

  const langs = getDefaultSubtitleLangs(deps.db);
  const subtitleDeps: Parameters<typeof fetchSubtitlesForItem>[3] = { apiKey };
  if (deps.subtitlesBaseUrl) subtitleDeps.baseUrl = deps.subtitlesBaseUrl;
  if (deps.fetchImpl) subtitleDeps.fetchImpl = deps.fetchImpl;

  try {
    const results = await fetchSubtitlesForItem(videoPath, row.stremioId, langs, subtitleDeps);
    for (const { lang } of results) addSubtitleLang(deps.db, row.id, lang);
  } catch (err) {
    // Best-effort — never fail a ready download over a subtitle problem —
    // but still worth recording so a persistently broken key/quota shows
    // up in the weekly rollup instead of silently doing nothing forever.
    recordError(deps.storageRoot, "subtitles", err, { installIdHash: deps.installIdHash ?? "unknown" });
  }
}

/**
 * Probes, decides copy-vs-transcode, runs ffmpeg, verifies, and atomically
 * publishes one row into the library — CLAUDE.md §3 Rule 1 and §4 Atomic
 * publication. Exported directly (not just via the background runner) so
 * tests can drive one row at a time deterministically.
 */
export async function processRemuxRow(deps: RemuxRunnerDeps, row: QueueRow): Promise<void> {
  if (!row.filePathOriginal) {
    markFailed(deps.db, row.id, "no file_path_original recorded", false);
    return;
  }

  const tempOut = remuxTempPath(deps.storageRoot, row.id);
  await fsp.mkdir(dirname(tempOut), { recursive: true });

  let probe;
  try {
    probe = await probeFile(row.filePathOriginal, deps.ffprobePath);
  } catch (err) {
    markFailed(deps.db, row.id, `probe failed: ${err instanceof Error ? err.message : String(err)}`, false);
    return;
  }

  const { plan } = decideRemuxPlan(probe);

  const ffmpegOpts: Parameters<typeof runFfmpeg>[3] = {};
  if (deps.ffmpegPath) ffmpegOpts.ffmpegPath = deps.ffmpegPath;
  if (deps.signal) ffmpegOpts.signal = deps.signal;

  const result = await runFfmpeg(row.filePathOriginal, tempOut, plan, ffmpegOpts);
  if (!result.success) {
    await fsp.rm(tempOut, { force: true });
    // ffmpeg failures against a fixed input are deterministic (bad codec
    // params, corrupt source) — retrying the identical command won't help,
    // so this is terminal rather than burning the retry budget.
    markFailed(deps.db, row.id, `ffmpeg (${plan}) failed: ${result.stderrTail.slice(-500)}`, false);
    return;
  }

  const verification = await verifyRemuxOutput(tempOut, probe.durationSeconds, deps.ffprobePath);
  if (!verification.ok) {
    await fsp.rm(tempOut, { force: true });
    markFailed(deps.db, row.id, `remux verification failed: ${verification.reason}`, false);
    return;
  }

  const finalPath = computeLibraryPath(deps.storageRoot, {
    type: row.type,
    title: row.title,
    year: row.year,
    season: row.season,
    episode: row.episode,
  });
  await fsp.mkdir(dirname(finalPath), { recursive: true });
  await fsp.rename(tempOut, finalPath); // atomic within a filesystem — CLAUDE.md §4

  // CLAUDE.md §10 P11: computed from the actual served file, after the
  // atomic rename — never from the pre-rename staging path, so a hash
  // recorded on the row always matches what /files/:id will actually serve.
  const [videoHash, { size: videoSize }] = await Promise.all([computeVideoHash(finalPath), fsp.stat(finalPath)]);
  markReady(deps.db, row.id, { filePathWebReady: finalPath, videoHash, videoSize });

  await fetchSubtitlesBestEffort(deps, row, finalPath);
  await triggerAutoDownloadNextEpisodeBestEffort(deps, row);
}

/**
 * Best-effort next-episode auto-download — CLAUDE.md §1/§10 P10. Wrapped
 * the same way fetchSubtitlesBestEffort is: any failure is recorded, never
 * propagated, and never affects the episode that just became `ready`.
 */
async function triggerAutoDownloadNextEpisodeBestEffort(deps: RemuxRunnerDeps, row: QueueRow): Promise<void> {
  const autoDownloadDeps: Parameters<typeof triggerAutoDownloadNextEpisodes>[0] = { db: deps.db, storageRoot: deps.storageRoot };
  if (deps.fetchImpl) autoDownloadDeps.fetchImpl = deps.fetchImpl;
  if (deps.installIdHash) autoDownloadDeps.installIdHash = deps.installIdHash;
  await triggerAutoDownloadNextEpisodes(autoDownloadDeps, row);
}

export interface RemuxRunnerHandle {
  stop: () => Promise<void>;
  /** Aborts (kills the ffmpeg process for) the in-flight remux for this row, if one is running here — used by DELETE /downloads/:id while remuxing. Returns whether a job was actually found. */
  abortRow: (id: string) => boolean;
  /** Currently-remuxing count — feeds /health's activeJobs. */
  activeCount: () => number;
}

function defaultConcurrency(): number {
  return Math.max(1, Math.min(2, cpus().length - 1));
}

/** Background worker pool for production use — index.ts wires this up. Tests call processRemuxRow() directly instead. */
export function startRemuxRunner(
  deps: RemuxRunnerDeps & { concurrency?: number; idlePollMs?: number },
): RemuxRunnerHandle {
  const semaphore = new Semaphore(deps.concurrency ?? defaultConcurrency());
  const inFlight = new Set<string>();
  const pending = new Set<Promise<void>>();
  // Per-row, not pool-wide — P5 needs to cancel one row's ffmpeg process
  // (a delete mid-remux) without disturbing other concurrent remuxes.
  const rowControllers = new Map<string, AbortController>();
  let stopped = false;

  deps.signal?.addEventListener("abort", () => {
    for (const controller of rowControllers.values()) controller.abort();
  });

  const loop = async (): Promise<void> => {
    while (!stopped) {
      const candidates = getRemuxingRows(deps.db).filter((r) => !inFlight.has(r.id));

      for (const row of candidates) {
        if (stopped) break;
        inFlight.add(row.id);
        const release = await semaphore.acquire();
        const controller = new AbortController();
        rowControllers.set(row.id, controller);
        const jobDeps: RemuxRunnerDeps = { db: deps.db, storageRoot: deps.storageRoot, signal: controller.signal };
        if (deps.ffmpegPath) jobDeps.ffmpegPath = deps.ffmpegPath;
        if (deps.ffprobePath) jobDeps.ffprobePath = deps.ffprobePath;
        if (deps.subtitlesBaseUrl) jobDeps.subtitlesBaseUrl = deps.subtitlesBaseUrl;
        if (deps.fetchImpl) jobDeps.fetchImpl = deps.fetchImpl;
        if (deps.installIdHash) jobDeps.installIdHash = deps.installIdHash;
        const job = processRemuxRow(jobDeps, row)
          .catch((err: unknown) => {
            // An unexpected exception, not one of processRemuxRow's own
            // handled failure paths (those already call markFailed and
            // return normally) — see the matching note in scheduler.ts.
            recordError(deps.storageRoot, "remuxRunner", err, { installIdHash: deps.installIdHash ?? "unknown" });
          })
          .finally(() => {
            inFlight.delete(row.id);
            rowControllers.delete(row.id);
            pending.delete(job);
            release();
          });
        pending.add(job);
      }

      await sleep(deps.idlePollMs ?? 5000);
    }
  };

  const iteration = loop();

  return {
    stop: async () => {
      stopped = true;
      for (const controller of rowControllers.values()) controller.abort();
      await iteration;
      await Promise.allSettled([...pending]);
    },
    abortRow: (id: string): boolean => {
      const controller = rowControllers.get(id);
      if (!controller) return false;
      controller.abort();
      return true;
    },
    activeCount: () => inFlight.size,
  };
}
