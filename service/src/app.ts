import cors from "@fastify/cors";
import { registerAddonRoutes } from "@stremio-offline/addon";
import type { Database } from "better-sqlite3";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { buildHealthReport } from "./api/health.js";
import { registerDebridAccountsRoutes } from "./api/debridAccounts.js";
import { registerDownloadsRoutes } from "./api/downloads.js";
import { buildSignedFileUrl, registerFilesRoute } from "./api/files.js";
import type { SubsystemStatus } from "@stremio-offline/shared";
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
    resolveBaseUrl: (req: FastifyRequest) => {
      try {
        return resolveBaseUrl(req, deps.configuredBaseUrl);
      } catch {
        return null;
      }
    },
  });

  return app;
}
