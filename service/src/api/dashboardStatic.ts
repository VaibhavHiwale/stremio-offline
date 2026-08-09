import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import staticPlugin from "@fastify/static";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";

// service/dist/api/dashboardStatic.js -> up three -> repo root -> dashboard/dist.
const DEFAULT_DASHBOARD_DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "dashboard", "dist");

/**
 * Serves the built React PWA (CLAUDE.md §5: "served statically by the
 * service") at `/`. Mounted last, after every API route, so nothing here
 * can shadow `/health`, `/downloads`, the addon's `/manifest.json`, etc.
 * If the dashboard hasn't been built yet (a dev running just the service),
 * this logs a warning and skips registration rather than crashing boot —
 * the REST API and Stremio addon surface work fine without it.
 */
export function registerDashboardStatic(app: FastifyInstance, logger: FastifyBaseLogger, distPath: string = DEFAULT_DASHBOARD_DIST): void {
  if (!existsSync(join(distPath, "index.html"))) {
    logger.warn({ distPath }, "dashboard/dist not found — skipping static dashboard serving (run `npm run build --workspace dashboard`)");
    return;
  }
  app.register(staticPlugin, { root: distPath, prefix: "/" });
}
