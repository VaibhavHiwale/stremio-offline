import type { Settings } from "@stremio-offline/shared";
import type { Database } from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { getSettings, updateSettings } from "../db/settings.js";

export interface SettingsRouteDeps {
  db: Database;
}

const VALID_QUALITIES = new Set(["480p", "720p", "1080p", "1440p", "4k", "original"]);

function validatePatch(body: Partial<Settings>): string | null {
  if (body.defaultQuality !== undefined && !VALID_QUALITIES.has(body.defaultQuality)) {
    return "defaultQuality is invalid";
  }
  if (body.maxConcurrentDownloads !== undefined && (!Number.isInteger(body.maxConcurrentDownloads) || body.maxConcurrentDownloads < 1)) {
    return "maxConcurrentDownloads must be a positive integer";
  }
  if (body.maxConcurrentRemuxes !== undefined && (!Number.isInteger(body.maxConcurrentRemuxes) || body.maxConcurrentRemuxes < 1)) {
    return "maxConcurrentRemuxes must be a positive integer";
  }
  if (body.subtitleLangs !== undefined && !Array.isArray(body.subtitleLangs)) {
    return "subtitleLangs must be an array of language codes";
  }
  return null;
}

/** `GET|PATCH /settings` — CLAUDE.md §8. Never exposes a way to set legalNoticeAcceptedAt (see legal.ts's dedicated accept flow) or wifi-only radio-state (server-side only per CLAUDE.md §2's locked-in deployment decision, but the flag itself remains a plain setting). */
export function registerSettingsRoutes(app: FastifyInstance, deps: SettingsRouteDeps): void {
  app.get("/settings", async (_req, reply) => {
    return reply.send(getSettings(deps.db));
  });

  app.patch<{ Body: Partial<Settings> }>("/settings", async (req, reply) => {
    const body = req.body ?? {};
    const error = validatePatch(body);
    if (error) return reply.code(400).send({ error });

    const { legalNoticeAcceptedAt: _ignored, ...safePatch } = body;
    return reply.send(updateSettings(deps.db, safePatch));
  });
}
