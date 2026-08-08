import type { FastifyInstance } from "fastify";
import { buildManifest } from "../manifest.js";

export interface ManifestRouteDeps {
  isLegalAccepted: () => boolean;
}

export function registerManifestRoutes(app: FastifyInstance, deps: ManifestRouteDeps): void {
  const send = () => buildManifest({ legalAccepted: deps.isLegalAccepted() });

  // Bare /manifest.json (default/no config) — the common case for a
  // self-hosted, single-tenant install. /:config/manifest.json exists for
  // Tier B's front-door relay (CLAUDE.md §11) and any future per-request config.
  app.get("/manifest.json", async () => send());
  app.get<{ Params: { config: string } }>("/:config/manifest.json", async () => send());
}
