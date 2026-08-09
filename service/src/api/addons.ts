import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { insertSourceAddon, listSourceAddons } from "../db/sourceAddons.js";
import { fetchAddonManifestInfo } from "../resolvers/addonClient.js";

export interface AddonsRouteDeps {
  db: Database;
  fetchImpl?: typeof fetch;
}

/**
 * `GET|POST /addons` — CLAUDE.md §8: "register source addon manifest URLs".
 * This is the registry `resolvers/addonClient.ts` (P10) queries for episode
 * streams; without at least one registered addon, auto-download has nothing
 * to query and manual downloads have no source to resolve from either.
 * No `DELETE /addons` — CLAUDE.md §8 doesn't list one, same precedent as
 * P8's storage-targets deferral; trivial to add later following
 * `DELETE /debrid-accounts/:service`'s exact shape.
 */
export function registerAddonsRoutes(app: FastifyInstance, deps: AddonsRouteDeps): void {
  app.get("/addons", async (_req, reply) => {
    return reply.send({ addons: listSourceAddons(deps.db) });
  });

  app.post<{ Body: { manifestUrl?: string } }>("/addons", async (req, reply) => {
    const manifestUrl = req.body?.manifestUrl;
    if (!manifestUrl) return reply.code(400).send({ error: "manifestUrl is required" });
    if (!manifestUrl.startsWith("http://") && !manifestUrl.startsWith("https://")) {
      return reply.code(400).send({ error: "manifestUrl must be an http(s) URL" });
    }

    let info: Awaited<ReturnType<typeof fetchAddonManifestInfo>>;
    try {
      info = await fetchAddonManifestInfo(manifestUrl, deps.fetchImpl);
    } catch (err) {
      return reply.code(422).send({ error: `could not register addon: ${err instanceof Error ? err.message : String(err)}` });
    }

    const id = randomUUID();
    insertSourceAddon(deps.db, { id, manifestUrl, name: info.name });
    // Idempotent by manifest_url (schema UNIQUE) — re-registering an
    // already-known addon just returns its existing row instead of erroring.
    const addons = listSourceAddons(deps.db);
    const saved = addons.find((a) => a.manifestUrl === manifestUrl)!;
    return reply.code(200).send(saved);
  });
}
