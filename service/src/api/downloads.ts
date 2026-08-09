import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import {
  cancelOrDeleteDownload,
  enqueueDownload,
  getFullById,
  listAll,
  pauseDownload,
  recordProgress,
  resumeDownload,
  retryDownload,
  setPriority,
} from "../db/downloadItems.js";
import type { RemuxRunnerHandle } from "../queue/remuxRunner.js";
import type { SchedulerHandle } from "../queue/scheduler.js";
import { cleanupDownloadFiles } from "../storage/cleanupFiles.js";

export interface DownloadsRouteDeps {
  db: Database;
  storageRoot: string;
  scheduler: SchedulerHandle;
  remuxRunner: RemuxRunnerHandle;
}

interface EnqueueBody {
  stremioId?: string;
  seriesId?: string | null;
  type?: "movie" | "series";
  title?: string;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
  quality?: string;
  sourceKind?: "http" | "magnet" | "debrid";
  sourceUrl?: string;
  storageTargetId?: string;
}

const VALID_QUALITIES = new Set(["480p", "720p", "1080p", "1440p", "4k", "original"]);
const VALID_SOURCE_KINDS = new Set(["http", "magnet", "debrid"]);
const VALID_TYPES = new Set(["movie", "series"]);

function validateEnqueueBody(body: EnqueueBody): string | null {
  if (!body.stremioId) return "stremioId is required";
  if (!body.type || !VALID_TYPES.has(body.type)) return "type must be 'movie' or 'series'";
  if (!body.title) return "title is required";
  if (!body.quality || !VALID_QUALITIES.has(body.quality)) return "quality is invalid";
  if (!body.sourceKind || !VALID_SOURCE_KINDS.has(body.sourceKind)) return "sourceKind is invalid";
  if (!body.sourceUrl) return "sourceUrl is required";
  // magnet/debrid rows carry a magnet URI in sourceUrl (P6) — the runner
  // resolves 'debrid' rows to a direct URL fresh on every attempt instead
  // of expecting an already-resolved link here.
  if ((body.sourceKind === "magnet" || body.sourceKind === "debrid") && !body.sourceUrl.startsWith("magnet:")) {
    return "sourceUrl must be a magnet: URI when sourceKind is 'magnet' or 'debrid'";
  }
  return null;
}

/**
 * The REST surface CLAUDE.md §8 lists for managing the queue — CLAUDE.md
 * §10 P5. Internal management API, not part of the Stremio addon protocol,
 * so (like /health and /files/:id) it's mounted without the `/:config`
 * prefix.
 */
export function registerDownloadsRoutes(app: FastifyInstance, deps: DownloadsRouteDeps): void {
  app.post<{ Body: EnqueueBody }>("/downloads", async (req, reply) => {
    const body = req.body ?? {};
    const validationError = validateEnqueueBody(body);
    if (validationError) return reply.code(400).send({ error: validationError });

    // enqueueDownload is idempotent by (stremioId, quality) via the schema's
    // UNIQUE constraint — CLAUDE.md §4: a double-enqueue must never create
    // two jobs. Look the row up by that natural key afterward (not the
    // generated id) so a duplicate POST returns the SAME job every caller.
    const inserted = enqueueDownload(deps.db, {
      id: randomUUID(),
      stremioId: body.stremioId!,
      seriesId: body.seriesId ?? null,
      type: body.type!,
      title: body.title!,
      year: body.year ?? null,
      season: body.season ?? null,
      episode: body.episode ?? null,
      quality: body.quality!,
      sourceKind: body.sourceKind!,
      sourceUrl: body.sourceUrl!,
      storageTargetId: body.storageTargetId ?? "default",
    });

    const existing = deps.db
      .prepare("SELECT id FROM download_items WHERE stremio_id = ? AND quality = ?")
      .get(body.stremioId, body.quality) as { id: string };
    const item = getFullById(deps.db, existing.id)!;
    return reply.code(inserted ? 201 : 200).send(item);
  });

  app.get<{ Querystring: { status?: string } }>("/downloads", async (req, reply) => {
    const opts: { status?: string } = {};
    if (req.query.status) opts.status = req.query.status;
    return reply.send({ items: listAll(deps.db, opts) });
  });

  app.get<{ Params: { id: string } }>("/downloads/:id", async (req, reply) => {
    const item = getFullById(deps.db, req.params.id);
    if (!item) return reply.code(404).send({ error: "not found" });
    return reply.send(item);
  });

  app.patch<{ Params: { id: string }; Body: { action?: "pause" | "resume" | "retry"; priority?: number } }>(
    "/downloads/:id",
    async (req, reply) => {
      const { id } = req.params;
      const body = req.body ?? {};

      if (body.action) {
        let opResult: "ok" | "not-found" | "invalid-state";
        switch (body.action) {
          case "pause":
            opResult = pauseDownload(deps.db, id);
            break;
          case "resume":
            opResult = resumeDownload(deps.db, id);
            break;
          case "retry":
            opResult = retryDownload(deps.db, id);
            break;
          default:
            return reply.code(400).send({ error: "action must be 'pause', 'resume', or 'retry'" });
        }

        if (opResult === "not-found") return reply.code(404).send({ error: "not found" });
        if (opResult === "invalid-state") {
          return reply.code(409).send({ error: `cannot ${body.action} this download in its current state` });
        }
        // The DB row is already flipped to 'paused'; also interrupt the live
        // transfer so it stops consuming bandwidth/writing to disk right away.
        if (body.action === "pause") deps.scheduler.abortRow(id);
      }

      if (body.priority !== undefined) {
        const ok = setPriority(deps.db, id, body.priority);
        if (!ok) return reply.code(404).send({ error: "not found" });
      }

      const item = getFullById(deps.db, id);
      if (!item) return reply.code(404).send({ error: "not found" });
      return reply.send(item);
    },
  );

  /**
   * CLAUDE.md §8: "player reports position." Whatever is actually playing
   * the file (dashboard player, external player script, etc.) calls this
   * with where playback got to — Stremio's own built-in player has no
   * protocol hook for this, so this only ever reflects what a client
   * chooses to report. Feeds `lastPositionSeconds`/`watched`, which in turn
   * feeds P8's auto-delete-after-watch sweep.
   */
  app.post<{ Params: { id: string }; Body: { positionSeconds?: number; durationSeconds?: number } }>(
    "/downloads/:id/progress",
    async (req, reply) => {
      const { positionSeconds, durationSeconds } = req.body ?? {};
      if (typeof positionSeconds !== "number" || !Number.isFinite(positionSeconds) || positionSeconds < 0) {
        return reply.code(400).send({ error: "positionSeconds must be a non-negative number" });
      }
      if (durationSeconds !== undefined && (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds < 0)) {
        return reply.code(400).send({ error: "durationSeconds must be a non-negative number when provided" });
      }

      const result = recordProgress(deps.db, req.params.id, { positionSeconds, durationSeconds: durationSeconds ?? null });
      if (result === "not-found") return reply.code(404).send({ error: "not found" });

      return reply.send(getFullById(deps.db, req.params.id)!);
    },
  );

  app.delete<{ Params: { id: string } }>("/downloads/:id", async (req, reply) => {
    const { id } = req.params;
    const before = getFullById(deps.db, id);
    if (!before) return reply.code(404).send({ error: "not found" });

    const result = cancelOrDeleteDownload(deps.db, id);
    if (result === "not-found") return reply.code(404).send({ error: "not found" });
    // "already-gone" (idempotent re-delete) and a fresh cancel/delete both
    // fall through to the same 200 response below — DELETE must be safe to
    // call twice, same as every other queue mutation (CLAUDE.md §4).

    if (before.status === "downloading") deps.scheduler.abortRow(id);
    if (before.status === "remuxing") deps.remuxRunner.abortRow(id);

    await cleanupDownloadFiles(deps.storageRoot, before);

    return reply.send(getFullById(deps.db, id)!);
  });
}
