import type { Database } from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { parseSubtitleLangs, queryByStremioId } from "../repository.js";
import type { SubtitlesResponse } from "../protocol.js";

interface SubtitlesParams {
  config?: string;
  type: string;
  id: string;
}

export interface SubtitlesRouteDeps {
  db: Database;
  /** Resolves a signed, absolute (never-loopback) URL for one language's sidecar .srt of a ready download_items row. */
  buildSubtitleUrl: (req: FastifyRequest, downloadItemId: string, lang: string) => string;
}

/**
 * Real subtitle serving via the addon's `subtitles` resource — CLAUDE.md §3
 * Rule 9: "Sidecar .srt only works where the client can see the
 * filesystem ... Serve through the addon's subtitles resource so it works
 * uniformly, including on platforms with no streaming server." Trusts
 * `download_items.subtitle_langs` (populated by P7's fetch pipeline once a
 * sidecar is actually written) rather than checking the filesystem itself
 * — keeps this package DB-only, like every other handler here.
 */
export function registerSubtitlesRoutes(app: FastifyInstance, deps: SubtitlesRouteDeps): void {
  async function handler(req: FastifyRequest<{ Params: SubtitlesParams }>, reply: FastifyReply) {
    const rows = queryByStremioId(deps.db, req.params.id).filter((row) => row.status === "ready");
    const subtitles = rows.flatMap((row) =>
      parseSubtitleLangs(row).map((lang) => ({
        id: `${row.id}-${lang}`,
        url: deps.buildSubtitleUrl(req, row.id, lang),
        lang,
      })),
    );
    return reply.send({ subtitles } satisfies SubtitlesResponse);
  }

  // See the comment in handlers/catalog.ts.
  app.get<{ Params: SubtitlesParams }>("/subtitles/:type/:id.json", handler);
  app.get<{ Params: SubtitlesParams }>("/:config/subtitles/:type/:id.json", handler);
}
