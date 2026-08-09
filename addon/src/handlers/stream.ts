import { basename } from "node:path";
import type { Database } from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { queryByStremioId, queuePosition, type DownloadItemRow } from "../repository.js";
import type { StreamBehaviorHints, StreamEntry, StreamResponse } from "../protocol.js";

export interface StreamRouteDeps {
  db: Database;
  isLegalAccepted: () => boolean;
  /** Resolves a signed, absolute (never-loopback) playback URL for a ready download_items row's web-ready MP4. */
  buildFileUrl: (req: FastifyRequest, downloadItemId: string) => string;
  /** Same, but for the pre-remux original file — CLAUDE.md §3 Rule 1's "second entry". */
  buildOriginalFileUrl: (req: FastifyRequest, downloadItemId: string) => string;
}

interface StreamParams {
  config?: string;
  type: string;
  id: string;
}

function formatSpeed(bps: number | null): string {
  if (!bps) return "";
  const mbps = bps / (1024 * 1024);
  return mbps >= 1 ? `${mbps.toFixed(1)} MB/s` : `${(bps / 1024).toFixed(0)} KB/s`;
}

function formatEta(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "";
  const min = Math.round(seconds / 60);
  return min < 1 ? "<1 min" : `~${min} min`;
}

/**
 * State-dependent stream entries — CLAUDE.md §3 Rule 6, "your entire UI".
 * `failed`/`paused`/`cancelled` rows are intentionally not surfaced as
 * clickable streams yet: a real retry action needs PATCH /downloads/:id
 * (P5), and surfacing a stream entry with no working target would violate
 * the same rule's "never an HTTP error" spirit. Likewise, titles with no
 * download_items row at all get no "download for offline" entry yet — that
 * needs a resolver (P6) to find a real source and a bundled ffmpeg (P4) to
 * generate the required confirmation clip; wiring a button that leads
 * nowhere real would be a half-finished feature, not a working one.
 */
function buildStreamEntries(req: FastifyRequest, row: DownloadItemRow, deps: StreamRouteDeps): StreamEntry[] {
  switch (row.status) {
    case "ready": {
      // CLAUDE.md §10 P11: a real filename (the actual served file's
      // basename, not the display title) plus videoHash/videoSize let
      // Stremio's own resume feature recognize this exact file across
      // sessions. videoHash is null for files under 128KB — see
      // media/videoHash.ts — so it's only included when present.
      const behaviorHints: StreamBehaviorHints = {
        filename: row.filePathWebReady ? basename(row.filePathWebReady) : row.title,
      };
      if (row.videoSize !== null) behaviorHints.videoSize = row.videoSize;
      if (row.videoHash !== null) behaviorHints.videoHash = row.videoHash;

      const entries: StreamEntry[] = [
        {
          name: `▶️ Play offline · ${row.quality}`,
          title: row.title,
          url: deps.buildFileUrl(req, row.id),
          behaviorHints,
        },
      ];
      // Rule 1: "optionally offer the original as a second entry ... for
      // desktop/Android users" — only those have a streaming server capable
      // of playing a non-web-ready source.
      if (row.filePathOriginal) {
        entries.push({
          name: "Original quality (needs streaming server)",
          title: row.title,
          url: deps.buildOriginalFileUrl(req, row.id),
          behaviorHints: { filename: row.title, notWebReady: true },
        });
      }
      return entries;
    }
    case "queued": {
      const position = queuePosition(deps.db, row);
      return [{ name: `🕐 Queued (position ${position})`, title: row.title }];
    }
    case "downloading": {
      const parts = [`${row.progressPct.toFixed(0)}%`, formatSpeed(row.speedBps), formatEta(row.etaSeconds)].filter(
        Boolean,
      );
      return [{ name: `⏳ Downloading… ${parts.join(" · ")}`, title: row.title }];
    }
    case "resolving":
      return [{ name: "🕐 Resolving source…", title: row.title }];
    case "remuxing":
    case "verifying":
      return [{ name: "⚙️ Preparing for playback…", title: row.title }];
    default:
      return [];
  }
}

export function registerStreamRoutes(app: FastifyInstance, deps: StreamRouteDeps): void {
  async function handler(req: FastifyRequest<{ Params: StreamParams }>, reply: FastifyReply) {
    if (!deps.isLegalAccepted()) {
      return reply.send({ streams: [] } satisfies StreamResponse);
    }

    const rows = queryByStremioId(deps.db, req.params.id);
    const streams = rows.flatMap((row) => buildStreamEntries(req, row, deps));

    return reply.send({ streams } satisfies StreamResponse);
  }

  // See the comment in handlers/catalog.ts.
  app.get<{ Params: StreamParams }>("/stream/:type/:id.json", handler);
  app.get<{ Params: StreamParams }>("/:config/stream/:type/:id.json", handler);
}
