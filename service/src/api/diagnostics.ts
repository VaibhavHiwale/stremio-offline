import type { SubsystemStatus } from "@stremio-offline/shared";
import type { Database } from "better-sqlite3";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { buildHealthReport } from "./health.js";
import { readRecentErrors } from "../observability/errorLog.js";
import { generateWeeklyRollupMarkdown } from "../observability/weeklyRollup.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface DiagnosticsRouteDeps {
  db: Database;
  storageRoot: string;
  configuredBaseUrl: string | null;
  resolveBaseUrl: (req: FastifyRequest) => string | null;
  getCertInfo: () => { status: SubsystemStatus; expiresAt: string | null };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function statusBadge(ok: boolean | null): string {
  if (ok === null) return `<span class="badge unknown">unknown</span>`;
  return ok ? `<span class="badge ok">ok</span>` : `<span class="badge fail">fail</span>`;
}

interface DiagnosticsPageData {
  baseUrl: string | null;
  certStatus: SubsystemStatus;
  certExpiresAt: string | null;
  ffmpegOk: boolean;
  dbOk: boolean;
  diskStatus: SubsystemStatus;
  manifestReachable: boolean | null;
  manifestError: string | null;
}

/**
 * CLAUDE.md §4: "a one-page self-test the user can screenshot into a bug
 * report: resolves the public base URL, checks HTTPS cert validity, probes
 * ffmpeg, and confirms the manifest is fetchable from outside localhost."
 */
function renderDiagnosticsPage(data: DiagnosticsPageData): string {
  const manifestUrl = data.baseUrl ? `${data.baseUrl}/manifest.json` : null;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Stremio Offline — Diagnostics</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1rem; line-height: 1.6; }
    table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
    td, th { text-align: left; padding: 0.5rem; border-bottom: 1px solid #ddd; }
    .badge { display: inline-block; padding: 0.15rem 0.6rem; border-radius: 999px; font-size: 0.85rem; font-weight: 600; }
    .badge.ok { background: #d4f4dd; color: #146c2e; }
    .badge.fail { background: #fbdada; color: #9b1c1c; }
    .badge.unknown { background: #eee; color: #555; }
    code { background: #f0f0f0; padding: 0.2rem 0.4rem; border-radius: 4px; word-break: break-all; }
  </style>
</head>
<body>
  <h1>Diagnostics</h1>
  <p>Generated ${new Date().toISOString()}. Screenshot this page into a bug report.</p>
  <table>
    <tr><th>Check</th><th>Result</th></tr>
    <tr><td>Public base URL</td><td>${data.baseUrl ? `<code>${escapeHtml(data.baseUrl)}</code>` : statusBadge(false) + " could not be resolved — see CLAUDE.md §3 Rule 3"}</td></tr>
    <tr><td>HTTPS certificate</td><td>${statusBadge(data.certStatus === "ok")} ${data.certExpiresAt ? `expires ${escapeHtml(data.certExpiresAt)}` : ""}</td></tr>
    <tr><td>ffmpeg / ffprobe</td><td>${statusBadge(data.ffmpegOk)}</td></tr>
    <tr><td>Database</td><td>${statusBadge(data.dbOk)}</td></tr>
    <tr><td>Disk</td><td>${statusBadge(data.diskStatus === "ok")}</td></tr>
    <tr><td>Manifest fetchable${manifestUrl ? ` (<code>${escapeHtml(manifestUrl)}</code>)` : ""}</td><td>${statusBadge(data.manifestReachable)} ${data.manifestError ? escapeHtml(data.manifestError) : ""}</td></tr>
  </table>
  <p><a href="/diagnostics/errors">Recent error log (JSON)</a></p>
</body>
</html>`;
}

/**
 * `GET /diagnostics` (CLAUDE.md §4) and `GET /diagnostics/errors` (the
 * error-capture system) — the latter computed fresh on every request from
 * the NDJSON log (cheap — just parsing a file), independent of the on-disk
 * `weekly-summary.md` that `observability/weeklyRollup.ts`'s
 * `persistWeeklyRollup` writes on a schedule.
 */
export function registerDiagnosticsRoutes(app: FastifyInstance, deps: DiagnosticsRouteDeps): void {
  app.get("/diagnostics/errors", async (_req, reply) => {
    const records = readRecentErrors(deps.storageRoot, WEEK_MS);
    const markdown = generateWeeklyRollupMarkdown(records);
    return reply.send({ generatedAt: new Date().toISOString(), recordCount: records.length, markdown });
  });

  app.get("/diagnostics", async (req, reply) => {
    let baseUrl: string | null;
    try {
      baseUrl = deps.resolveBaseUrl(req);
    } catch {
      baseUrl = null;
    }

    const certInfo = deps.getCertInfo();
    const health = await buildHealthReport({
      db: deps.db,
      storageRoot: deps.storageRoot,
      activeJobs: 0,
      certStatus: certInfo.status,
      certExpiresAt: certInfo.expiresAt,
    });

    let manifestReachable: boolean | null = null;
    let manifestError: string | null = null;
    if (baseUrl) {
      try {
        const res = await fetch(`${baseUrl}/manifest.json`);
        manifestReachable = res.ok;
        if (!res.ok) manifestError = `HTTP ${res.status}`;
      } catch (err) {
        manifestReachable = false;
        manifestError = err instanceof Error ? err.message : String(err);
      }
    }

    const html = renderDiagnosticsPage({
      baseUrl,
      certStatus: certInfo.status,
      certExpiresAt: certInfo.expiresAt,
      ffmpegOk: health.subsystems.ffmpeg === "ok",
      dbOk: health.subsystems.db === "ok",
      diskStatus: health.subsystems.disk,
      manifestReachable,
      manifestError,
    });
    reply.header("Content-Type", "text/html; charset=utf-8");
    return reply.send(html);
  });
}
