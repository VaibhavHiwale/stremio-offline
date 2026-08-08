import type { Database } from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { queryBySeriesId, queryByStremioId, type DownloadItemRow } from "../repository.js";
import type { Meta, MetaResponse, Video } from "../protocol.js";

export interface MetaRouteDeps {
  db: Database;
  isLegalAccepted: () => boolean;
}

interface MetaParams {
  config?: string;
  type: string;
  id: string;
}

// Prefer showing the most "finished" state as the representative row when a
// title has multiple quality variants — a viewer cares whether *something*
// is ready to play, not which quality got there first.
const STATUS_PREFERENCE = ["ready", "verifying", "remuxing", "downloading", "resolving", "queued", "paused", "failed"];

function pickRepresentative(rows: DownloadItemRow[]): DownloadItemRow | undefined {
  return [...rows].sort((a, b) => STATUS_PREFERENCE.indexOf(a.status) - STATUS_PREFERENCE.indexOf(b.status))[0];
}

function episodeTitle(row: DownloadItemRow): string {
  if (row.season != null && row.episode != null) {
    return `S${String(row.season).padStart(2, "0")}E${String(row.episode).padStart(2, "0")} — ${row.title}`;
  }
  return row.title;
}

export function registerMetaRoutes(app: FastifyInstance, deps: MetaRouteDeps): void {
  async function handler(req: FastifyRequest<{ Params: MetaParams }>, reply: FastifyReply) {
    const { type, id } = req.params;

    if (!deps.isLegalAccepted()) {
      return reply.code(404).send({ error: "not found" });
    }

    if (type === "movie") {
      const rows = queryByStremioId(deps.db, id);
      const row = pickRepresentative(rows);
      if (!row) return reply.code(404).send({ error: "not found" });

      const meta: Meta = {
        id: row.stremioId,
        type: "movie",
        name: row.title,
        ...(row.year ? { releaseInfo: String(row.year) } : {}),
      };
      return reply.send({ meta } satisfies MetaResponse);
    }

    // series: id is the show's series_id; group episode rows into `videos`.
    const episodeRows = queryBySeriesId(deps.db, id);
    if (episodeRows.length === 0) return reply.code(404).send({ error: "not found" });

    const byEpisodeKey = new Map<string, DownloadItemRow>();
    for (const row of episodeRows) {
      const key = `${row.season}:${row.episode}`;
      const existing = byEpisodeKey.get(key);
      if (!existing || STATUS_PREFERENCE.indexOf(row.status) < STATUS_PREFERENCE.indexOf(existing.status)) {
        byEpisodeKey.set(key, row);
      }
    }

    const videos: Video[] = [...byEpisodeKey.values()].map((row) => ({
      id: row.stremioId,
      title: episodeTitle(row),
      ...(row.season != null ? { season: row.season } : {}),
      ...(row.episode != null ? { episode: row.episode } : {}),
    }));

    const representative = pickRepresentative(episodeRows)!;
    const meta: Meta = {
      id,
      type: "series",
      name: representative.title,
      ...(representative.year ? { releaseInfo: String(representative.year) } : {}),
      videos,
    };
    return reply.send({ meta } satisfies MetaResponse);
  }

  // See the comment in handlers/catalog.ts: both bare and config-prefixed
  // forms must exist since Stremio derives resource URLs from whichever
  // manifest URL it actually installed.
  app.get<{ Params: MetaParams }>("/meta/:type/:id.json", handler);
  app.get<{ Params: MetaParams }>("/:config/meta/:type/:id.json", handler);
}
