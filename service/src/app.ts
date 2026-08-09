import cors from "@fastify/cors";
import { registerAddonRoutes } from "@stremio-offline/addon";
import type { Database } from "better-sqlite3";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { registerAddonsRoutes } from "./api/addons.js";
import { registerDashboardStatic } from "./api/dashboardStatic.js";
import { registerDebridAccountsRoutes } from "./api/debridAccounts.js";
import { registerDiagnosticsRoutes } from "./api/diagnostics.js";
import { buildHealthReport } from "./api/health.js";
import { registerDownloadsRoutes } from "./api/downloads.js";
import { buildSignedFileUrl, registerFilesRoute } from "./api/files.js";
import { registerSettingsRoutes } from "./api/settings.js";
import { registerStorageTargetsRoutes } from "./api/storageTargets.js";
import { registerWsProgressRoute } from "./api/wsProgress.js";
import type { SubsystemStatus } from "@stremio-offline/shared";
import { recordError } from "./observability/errorLog.js";
import type { RemuxRunnerHandle } from "./queue/remuxRunner.js";
import type { SchedulerHandle } from "./queue/scheduler.js";
import { resolveBaseUrl } from "./transport/baseUrl.js";

const FILE_URL_TTL_SECONDS = 6 * 60 * 60; // long enough for a full movie to buffer/seek around in

export interface AppDeps {
  db: Database;
  storageRoot: string;
  fileTokenSecret: string;
  scheduler: SchedulerHandle;
  remuxRunner: RemuxRunnerHandle;
  installIdHash: string;
  /** Explicit override (env PUBLIC_BASE_URL, or the domain from an acquired cert) — see transport/baseUrl.ts. */
  configuredBaseUrl: string | null;
  /** Read live, not snapshotted — cert acquisition finishes after boot. */
  getCertInfo: () => { status: SubsystemStatus; expiresAt: string | null };
  logger: { level: string; redact: string[] };
  https?: { key: string; cert: string };
}

/**
 * Builds one Fastify instance with the full route set. Called twice in
 * index.ts — once for the localhost-only HTTP listener (diagnostics/health,
 * plain HTTP is only ever acceptable on localhost per CLAUDE.md §3 Rule 2)
 * and once for the LAN-facing HTTPS listener once a certificate is
 * available.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  // Fastify's http/https overloads return distinct generic instance types,
  // and TS's overload resolution here fights exactOptionalPropertyTypes.
  // This builder is shared between both listeners and only ever touches the
  // generic FastifyInstance surface (route/register/listen/close), so we
  // deliberately drop to `any` for construction and normalize back to that
  // surface, rather than threading the server generic through every caller.
  const options: FastifyServerOptions = { logger: deps.logger };
  if (deps.https) (options as { https?: AppDeps["https"] }).https = deps.https;
  const app = Fastify(options as never) as unknown as FastifyInstance;

  // CORS on every route — Stremio Web fetches these cross-origin. See Rule 8.
  app.register(cors, { origin: true });

  // Catches anything a route handler threw instead of handling itself (a DB
  // write failure, an unexpected null, ...) — records it before Fastify's
  // default 500 response, so REST-originated failures show up in the
  // weekly rollup the same way scheduler/remuxRunner job failures do.
  app.setErrorHandler((err, req, reply) => {
    recordError(deps.storageRoot, "rest", err, { requestPath: req.url, installIdHash: deps.installIdHash });
    const statusCode = "statusCode" in err && typeof err.statusCode === "number" ? err.statusCode : 500;
    reply.code(statusCode).send({ error: statusCode === 500 ? "internal server error" : err.message });
  });

  app.get("/health", async (_req, reply) => {
    const certInfo = deps.getCertInfo();
    const report = await buildHealthReport({
      db: deps.db,
      storageRoot: deps.storageRoot,
      activeJobs: deps.scheduler.activeCount() + deps.remuxRunner.activeCount(),
      certStatus: certInfo.status,
      certExpiresAt: certInfo.expiresAt,
    });
    return reply.code(report.status === "down" ? 503 : 200).send(report);
  });

  registerFilesRoute(app, { db: deps.db, secret: deps.fileTokenSecret });

  registerDownloadsRoutes(app, {
    db: deps.db,
    storageRoot: deps.storageRoot,
    scheduler: deps.scheduler,
    remuxRunner: deps.remuxRunner,
  });

  registerDebridAccountsRoutes(app, { db: deps.db });

  registerAddonsRoutes(app, { db: deps.db });

  const safeResolveBaseUrl = (req: FastifyRequest): string | null => {
    try {
      return resolveBaseUrl(req, deps.configuredBaseUrl);
    } catch {
      return null;
    }
  };

  registerDiagnosticsRoutes(app, {
    db: deps.db,
    storageRoot: deps.storageRoot,
    configuredBaseUrl: deps.configuredBaseUrl,
    resolveBaseUrl: safeResolveBaseUrl,
    getCertInfo: deps.getCertInfo,
  });

  registerStorageTargetsRoutes(app, { db: deps.db });

  registerSettingsRoutes(app, { db: deps.db });

  registerWsProgressRoute(app, { db: deps.db });

  registerAddonRoutes(app, {
    db: deps.db,
    buildFileUrl: (req: FastifyRequest, downloadItemId: string) => {
      const baseUrl = resolveBaseUrl(req, deps.configuredBaseUrl);
      return buildSignedFileUrl(baseUrl, deps.fileTokenSecret, downloadItemId, FILE_URL_TTL_SECONDS);
    },
    buildOriginalFileUrl: (req: FastifyRequest, downloadItemId: string) => {
      const baseUrl = resolveBaseUrl(req, deps.configuredBaseUrl);
      return buildSignedFileUrl(baseUrl, deps.fileTokenSecret, downloadItemId, FILE_URL_TTL_SECONDS, "original");
    },
    buildSubtitleUrl: (req: FastifyRequest, downloadItemId: string, lang: string) => {
      const baseUrl = resolveBaseUrl(req, deps.configuredBaseUrl);
      return buildSignedFileUrl(baseUrl, deps.fileTokenSecret, downloadItemId, FILE_URL_TTL_SECONDS, "subtitle", lang);
    },
    resolveBaseUrl: safeResolveBaseUrl,
  });

  // Mounted last — nothing here should ever be able to shadow an API route above.
  registerDashboardStatic(app, app.log);

  return app;
}
