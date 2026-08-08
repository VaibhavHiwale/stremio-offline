import type { Database } from "better-sqlite3";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { registerCatalogRoutes } from "./handlers/catalog.js";
import { registerManifestRoutes } from "./handlers/manifestRoute.js";
import { registerMetaRoutes } from "./handlers/meta.js";
import { registerStreamRoutes } from "./handlers/stream.js";
import { registerSubtitlesRoutes } from "./handlers/subtitles.js";
import { registerConfigureRoutes } from "./configurePage.js";
import { isLegalAccepted } from "./legal.js";

export interface AddonDeps {
  db: Database;
  buildFileUrl: (req: FastifyRequest, downloadItemId: string) => string;
  resolveBaseUrl: (req: FastifyRequest) => string | null;
}

/** Wires the full addon surface (manifest/catalog/meta/stream/subtitles/configure) onto a Fastify instance. */
export function registerAddonRoutes(app: FastifyInstance, deps: AddonDeps): void {
  const legalAccepted = () => isLegalAccepted(deps.db);

  registerManifestRoutes(app, { isLegalAccepted: legalAccepted });
  registerCatalogRoutes(app, { db: deps.db, isLegalAccepted: legalAccepted });
  registerMetaRoutes(app, { db: deps.db, isLegalAccepted: legalAccepted });
  registerStreamRoutes(app, { db: deps.db, isLegalAccepted: legalAccepted, buildFileUrl: deps.buildFileUrl });
  registerSubtitlesRoutes(app);
  registerConfigureRoutes(app, { db: deps.db, resolveBaseUrl: deps.resolveBaseUrl });
}

export { buildManifest, MOVIE_CATALOG_ID, SERIES_CATALOG_ID } from "./manifest.js";
export * from "./protocol.js";
