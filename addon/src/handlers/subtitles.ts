import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SubtitlesResponse } from "../protocol.js";

interface SubtitlesParams {
  config?: string;
  type: string;
  id: string;
}

/**
 * Protocol-valid empty response — real subtitle search/sidecar serving is P7
 * (CLAUDE.md §3 Rule 9). Responding here (rather than 404) keeps the client
 * from treating subtitle lookup as a hard error on every title.
 */
export function registerSubtitlesRoutes(app: FastifyInstance): void {
  async function handler(_req: FastifyRequest<{ Params: SubtitlesParams }>, reply: FastifyReply) {
    return reply.send({ subtitles: [] } satisfies SubtitlesResponse);
  }

  // See the comment in handlers/catalog.ts.
  app.get<{ Params: SubtitlesParams }>("/subtitles/:type/:id.json", handler);
  app.get<{ Params: SubtitlesParams }>("/:config/subtitles/:type/:id.json", handler);
}
