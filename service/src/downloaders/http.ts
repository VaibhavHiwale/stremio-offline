import { createWriteStream, promises as fsp } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { hasSufficientSpace } from "../storage/diskspace.js";
import { isAbortError, isRetryableError, isRetryableStatus, isNetworkLossError } from "./errors.js";

export type DownloadOutcome =
  | { kind: "complete"; bytesTotal: number; etag: string | null }
  | { kind: "paused-disk-full" }
  | { kind: "paused-network"; message: string }
  | { kind: "retryable-error"; message: string }
  | { kind: "terminal-error"; message: string }
  | { kind: "verification-failed"; message: string };

export interface DownloadDeps {
  fetchImpl?: typeof fetch;
  onProgress?: (bytesDownloaded: number, bytesTotal: number | null) => void;
  /** Fired once headers are in, before the body streams — see the ETag note below. */
  onHeaders?: (info: { etag: string | null; bytesTotal: number | null }) => void;
  /** Injectable for tests; defaults to the real filesystem-backed guard. */
  checkDiskSpace?: (destPath: string, neededBytes: number) => Promise<boolean>;
  progressIntervalMs?: number;
  diskCheckIntervalMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_PROGRESS_INTERVAL_MS = 500;
const DEFAULT_DISK_CHECK_INTERVAL_MS = 30_000;

function parseContentRangeTotal(header: string | null): number | null {
  // "bytes 100-999/1000"
  const match = header ? /\/(\d+)$/.exec(header) : null;
  return match?.[1] ? Number(match[1]) : null;
}

/**
 * Downloads `sourceUrl` into `destPath`, resuming from the file's actual
 * on-disk size if it already exists — CLAUDE.md §4 Resumability. Never
 * trusts a caller-supplied "how much we already have" figure; the
 * filesystem is the only source of truth, same principle as boot
 * reconciliation.
 */
export async function downloadToPart(
  sourceUrl: string,
  destPath: string,
  opts: { knownEtag: string | null },
  deps: DownloadDeps = {},
): Promise<DownloadOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  const checkDiskSpace = deps.checkDiskSpace ?? hasSufficientSpace;
  const progressIntervalMs = deps.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
  const diskCheckIntervalMs = deps.diskCheckIntervalMs ?? DEFAULT_DISK_CHECK_INTERVAL_MS;

  await fsp.mkdir(dirname(destPath), { recursive: true });

  let offset = 0;
  try {
    const stat = await fsp.stat(destPath);
    offset = stat.size;
  } catch {
    offset = 0;
  }

  const headers: Record<string, string> = {};
  if (offset > 0) headers.Range = `bytes=${offset}-`;

  const requestInit: RequestInit = { headers };
  if (deps.signal) requestInit.signal = deps.signal;

  let response: Response;
  try {
    response = await doFetch(sourceUrl, requestInit);
  } catch (err) {
    if (isAbortError(err)) {
      return { kind: "paused-network", message: "shutdown requested" };
    }
    if (isNetworkLossError(err)) {
      return { kind: "paused-network", message: err instanceof Error ? err.message : String(err) };
    }
    if (isRetryableError(err)) {
      return { kind: "retryable-error", message: err instanceof Error ? err.message : String(err) };
    }
    return { kind: "terminal-error", message: err instanceof Error ? err.message : String(err) };
  }

  if (!response.ok && !(response.status === 206)) {
    await response.body?.cancel().catch(() => undefined);
    if (isRetryableStatus(response.status)) {
      return { kind: "retryable-error", message: `HTTP ${response.status}` };
    }
    return { kind: "terminal-error", message: `HTTP ${response.status}` };
  }

  const responseEtag = response.headers.get("etag");

  // Remote file changed since we last downloaded part of it — discard local
  // progress and restart clean rather than silently splicing two different
  // files together. CLAUDE.md §4: "if they change on resume, discard and restart."
  if (offset > 0 && opts.knownEtag && responseEtag && responseEtag !== opts.knownEtag) {
    await response.body?.cancel().catch(() => undefined);
    await fsp.rm(destPath, { force: true });
    return downloadToPart(sourceUrl, destPath, { knownEtag: null }, deps);
  }

  const resumeHonored = offset > 0 && response.status === 206;
  const writeOffset = resumeHonored ? offset : 0;
  const contentLength = response.headers.get("content-length");

  const bytesTotal = resumeHonored
    ? parseContentRangeTotal(response.headers.get("content-range"))
    : contentLength
      ? Number(contentLength)
      : null;

  // Server ignored our Range request (returned 200 for a resume attempt) —
  // must not append, or we'd splice a full body onto existing bytes and
  // silently corrupt the file. Restart the write from zero using this
  // response's body instead of throwing away a perfectly good response.
  const writeFlag = resumeHonored ? "a" : "w";

  if (!resumeHonored && offset > 0) {
    await fsp.rm(destPath, { force: true });
  }

  // Record the ETag as soon as we know it — CLAUDE.md §4: "Store ETag ... at
  // start." If the transfer dies mid-stream below, the caller still needs
  // this to detect a remote change on the *next* resume attempt.
  deps.onHeaders?.({ etag: responseEtag, bytesTotal });

  const remainingEstimate = bytesTotal !== null ? bytesTotal - writeOffset : null;
  if (remainingEstimate !== null && !(await checkDiskSpace(destPath, remainingEstimate))) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: "paused-disk-full" };
  }

  if (!response.body) {
    return { kind: "terminal-error", message: "response had no body" };
  }

  const nodeStream = Readable.fromWeb(response.body as never);
  const writeStream = createWriteStream(destPath, { flags: writeFlag });

  let bytesWrittenThisSession = 0;
  let lastProgressAt = 0;
  let lastDiskCheckAt = Date.now();
  let diskFull = false;

  nodeStream.on("data", (chunk: Buffer) => {
    bytesWrittenThisSession += chunk.length;
    const now = Date.now();

    if (now - lastProgressAt >= progressIntervalMs) {
      lastProgressAt = now;
      deps.onProgress?.(writeOffset + bytesWrittenThisSession, bytesTotal);
    }

    if (now - lastDiskCheckAt >= diskCheckIntervalMs) {
      lastDiskCheckAt = now;
      void checkDiskSpace(destPath, 0).then((ok) => {
        if (!ok) {
          diskFull = true;
          nodeStream.destroy(new Error("disk full"));
        }
      });
    }
  });

  try {
    // pipeline (not .pipe() + finished()) so a source-side destroy correctly
    // propagates to and cleans up the write stream — .pipe() alone doesn't
    // cascade errors, which left an unhandled 'error' event on nodeStream
    // when the disk-space guard destroyed it.
    await pipeline(nodeStream, writeStream);
  } catch (err) {
    if (diskFull) return { kind: "paused-disk-full" };
    if (isAbortError(err)) {
      return { kind: "paused-network", message: "shutdown requested" };
    }
    if (isNetworkLossError(err)) {
      return { kind: "paused-network", message: err instanceof Error ? err.message : String(err) };
    }
    if (isRetryableError(err)) {
      return { kind: "retryable-error", message: err instanceof Error ? err.message : String(err) };
    }
    return { kind: "terminal-error", message: err instanceof Error ? err.message : String(err) };
  }

  deps.onProgress?.(writeOffset + bytesWrittenThisSession, bytesTotal);

  const finalStat = await fsp.stat(destPath);
  if (bytesTotal !== null && finalStat.size !== bytesTotal) {
    return {
      kind: "verification-failed",
      message: `size mismatch: expected ${bytesTotal} bytes, got ${finalStat.size}`,
    };
  }

  return { kind: "complete", bytesTotal: finalStat.size, etag: responseEtag };
}
