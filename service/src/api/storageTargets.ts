import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { getStorageTarget, listStorageTargets, upsertStorageTarget } from "../db/storageTargets.js";
import { getDiskUsage } from "../storage/diskspace.js";
import { refreshAllTargetUsage } from "../storage/targets.js";

export interface StorageTargetsRouteDeps {
  db: Database;
}

interface RegisterTargetBody {
  label?: string;
  path?: string;
  isRemovable?: boolean;
}

/**
 * `GET|POST /storage/targets` and `GET /storage/usage` — CLAUDE.md §8.
 * Registering a target here is how an admin adds an external SD/USB/NAS
 * mount beyond the always-present `default` one (see storage/targets.ts's
 * docstring for why this is manual, not auto-discovered).
 */
export function registerStorageTargetsRoutes(app: FastifyInstance, deps: StorageTargetsRouteDeps): void {
  app.get("/storage/targets", async (_req, reply) => {
    return reply.send({ targets: listStorageTargets(deps.db) });
  });

  app.post<{ Body: RegisterTargetBody }>("/storage/targets", async (req, reply) => {
    const body = req.body ?? {};
    if (!body.label) return reply.code(400).send({ error: "label is required" });
    if (!body.path) return reply.code(400).send({ error: "path is required" });

    const usage = await getDiskUsage(body.path);
    if (!usage) {
      return reply.code(400).send({ error: `path is not a reachable/writable directory: ${body.path}` });
    }

    const id = randomUUID();
    upsertStorageTarget(deps.db, {
      id,
      label: body.label,
      path: body.path,
      isRemovable: body.isRemovable ?? true,
      isDefault: false,
      writable: true,
    });
    return reply.code(201).send(getStorageTarget(deps.db, id));
  });

  // Unlike GET /storage/targets (cached, last-known figures — fast), this
  // does the real statfs calls first, so it's the one to hit for an
  // up-to-the-moment "how much space is left" check.
  app.get("/storage/usage", async (_req, reply) => {
    await refreshAllTargetUsage(deps.db);
    return reply.send({ targets: listStorageTargets(deps.db) });
  });
}
