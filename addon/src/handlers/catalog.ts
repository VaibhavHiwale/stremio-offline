import type { Database } from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MOVIE_CATALOG_ID, SERIES_CATALOG_ID } from "../manifest.js";
import { queryCatalog } from "../repository.js";
import type { CatalogResponse, MetaPreview } from "../protocol.js";

const PAGE_SIZE = 100;

function parseExtra(extra: string | undefined): { search: string | null; skip: number } {
  if (!extra) return { search: null, skip: 0 };
  const params = new URLSearchParams(extra);
  const skipRaw = params.get("skip");
  const skip = skipRaw ? Math.max(0, Number(skipRaw) || 0) : 0;
  // genre is accepted (required by the manifest's `extra` declaration so
  // clients don't withhold the request) but not filterable — we don't store
  // genre metadata; see the P2 scope note in repository.ts.
  return { search: params.get("search"), skip };
}

export interface CatalogRouteDeps {
  db: Database;
  isLegalAccepted: () => boolean;
}

interface CatalogParams {
  config?: string;
  type: string;
  id: string;
  extra?: string;
}

export function registerCatalogRoutes(app: FastifyInstance, deps: CatalogRouteDeps): void {
  async function handler(req: FastifyRequest<{ Params: CatalogParams }>, reply: FastifyReply) {
    const { type, id } = req.params;

    if (!deps.isLegalAccepted() || (id !== MOVIE_CATALOG_ID && id !== SERIES_CATALOG_ID)) {
      return reply.send({ metas: [] } satisfies CatalogResponse);
    }
    if ((id === MOVIE_CATALOG_ID && type !== "movie") || (id === SERIES_CATALOG_ID && type !== "series")) {
      return reply.send({ metas: [] } satisfies CatalogResponse);
    }

    const { search, skip } = parseExtra(req.params.extra);
    const entries = queryCatalog(deps.db, { type: type as "movie" | "series", search, skip, limit: PAGE_SIZE });

    const metas: MetaPreview[] = entries.map((e) => ({
      id: e.id,
      type,
      name: e.title,
      ...(e.year ? { releaseInfo: String(e.year) } : {}),
    }));

    return reply.send({ metas } satisfies CatalogResponse);
  }

  // Stremio derives resource URLs by stripping "manifest.json" off whatever
  // manifest URL it fetched and prepending that prefix to every resource
  // request — so a client that installed via the bare /manifest.json will
  // request bare /catalog/..., never /:config/catalog/.... Both must exist.
  app.get<{ Params: CatalogParams }>("/catalog/:type/:id.json", handler);
  app.get<{ Params: CatalogParams }>("/catalog/:type/:id/:extra.json", handler);
  app.get<{ Params: CatalogParams }>("/:config/catalog/:type/:id.json", handler);
  app.get<{ Params: CatalogParams }>("/:config/catalog/:type/:id/:extra.json", handler);
}
