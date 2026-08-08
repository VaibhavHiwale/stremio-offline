import cors from "@fastify/cors";
import type { Database } from "better-sqlite3";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { buildHealthReport } from "./api/health.js";
import { registerFilesRoute } from "./api/files.js";
import type { SubsystemStatus } from "@stremio-offline/shared";

export interface AppDeps {
  db: Database;
  storageRoot: string;
  fileTokenSecret: string;
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
      activeJobs: 0,
      certStatus: certInfo.status,
      certExpiresAt: certInfo.expiresAt,
      debridStatus: "down",
    });
    return reply.code(report.status === "down" ? 503 : 200).send(report);
  });

  registerFilesRoute(app, { db: deps.db, secret: deps.fileTokenSecret });

  return app;
}
