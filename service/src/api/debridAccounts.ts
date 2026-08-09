import type { DebridService } from "@stremio-offline/shared";
import type { Database } from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { deleteDebridAccount, listDebridAccounts, upsertDebridAccount } from "../db/debridAccounts.js";

export interface DebridAccountsRouteDeps {
  db: Database;
}

const VALID_SERVICES = new Set<DebridService>(["realdebrid", "alldebrid", "premiumize", "debridlink", "torbox"]);

/** Never echo the full key back — CLAUDE.md §4 Observability: "no tokens or personal data in logs ever" extends naturally to API responses a dashboard might display/screenshot. */
function maskApiKey(apiKey: string): string {
  return apiKey.length <= 4 ? "****" : `${"*".repeat(apiKey.length - 4)}${apiKey.slice(-4)}`;
}

/**
 * Manages which debrid service(s) the resolvers (P6) use — not explicitly
 * listed in CLAUDE.md §8's API surface table, but resolvers/autodetect.ts
 * needs *some* way to learn a configured API key, and this is the plain
 * REST equivalent of the existing `GET|POST /addons` pattern for source
 * addons. Mounted without `/:config` — internal management API, same as
 * `/downloads` and `/health`.
 */
export function registerDebridAccountsRoutes(app: FastifyInstance, deps: DebridAccountsRouteDeps): void {
  app.get("/debrid-accounts", async (_req, reply) => {
    const accounts = listDebridAccounts(deps.db).map((a) => ({ ...a, apiKey: maskApiKey(a.apiKey) }));
    return reply.send({ accounts });
  });

  app.post<{ Body: { service?: string; apiKey?: string; enabled?: boolean } }>("/debrid-accounts", async (req, reply) => {
    const body = req.body ?? {};
    if (!body.service || !VALID_SERVICES.has(body.service as DebridService)) {
      return reply.code(400).send({ error: `service must be one of: ${[...VALID_SERVICES].join(", ")}` });
    }
    if (!body.apiKey) return reply.code(400).send({ error: "apiKey is required" });

    upsertDebridAccount(deps.db, {
      service: body.service as DebridService,
      apiKey: body.apiKey,
      enabled: body.enabled ?? true,
    });
    return reply.code(200).send({ service: body.service, apiKey: maskApiKey(body.apiKey), enabled: body.enabled ?? true });
  });

  app.delete<{ Params: { service: string } }>("/debrid-accounts/:service", async (req, reply) => {
    const { service } = req.params;
    if (!VALID_SERVICES.has(service as DebridService)) {
      return reply.code(400).send({ error: `service must be one of: ${[...VALID_SERVICES].join(", ")}` });
    }
    const deleted = deleteDebridAccount(deps.db, service as DebridService);
    if (!deleted) return reply.code(404).send({ error: "not found" });
    return reply.code(204).send();
  });
}
