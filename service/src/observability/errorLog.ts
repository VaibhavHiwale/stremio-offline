import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ErrorRecord {
  timestamp: string; // ISO 8601
  component: string; // e.g. "resolver:realdebrid", "scheduler", "remuxRunner", "rest", "subtitles"
  errorType: string;
  message: string;
  stack?: string;
  requestPath?: string;
  installIdHash: string;
}

export function errorLogPath(storageRoot: string): string {
  return join(storageRoot, ".offline", "logs", "errors.ndjson");
}

function classify(err: unknown): { errorType: string; message: string; stack?: string } {
  if (err instanceof Error) {
    const result: { errorType: string; message: string; stack?: string } = {
      errorType: err.name || "Error",
      message: err.message,
    };
    if (err.stack) result.stack = err.stack;
    return result;
  }
  return { errorType: "UnknownError", message: String(err) };
}

/**
 * Appends one structured record for an unhandled failure — resolver
 * exceptions, DB write failures, REST handler errors, etc. Deliberately
 * synchronous: errors are rare, the write is a few hundred bytes, and a
 * fire-and-forget async write risks losing the very record a crash
 * shortly after would need. Never throws itself — a broken error logger
 * must not become a second failure on top of the first.
 */
export function recordError(
  storageRoot: string,
  component: string,
  err: unknown,
  extra: { requestPath?: string; installIdHash: string },
): void {
  try {
    const path = errorLogPath(storageRoot);
    mkdirSync(dirname(path), { recursive: true });
    const record: ErrorRecord = {
      timestamp: new Date().toISOString(),
      component,
      installIdHash: extra.installIdHash,
      ...classify(err),
      ...(extra.requestPath ? { requestPath: extra.requestPath } : {}),
    };
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // See docstring — never let the error logger itself throw.
  }
}

export function readRecentErrors(storageRoot: string, sinceMs: number): ErrorRecord[] {
  let content: string;
  try {
    content = readFileSync(errorLogPath(storageRoot), "utf8");
  } catch {
    return [];
  }

  const cutoff = Date.now() - sinceMs;
  const records: ErrorRecord[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as ErrorRecord;
      if (new Date(record.timestamp).getTime() >= cutoff) records.push(record);
    } catch {
      // A corrupted line (e.g. a torn write across a crash) is skipped, not fatal.
    }
  }
  return records;
}
