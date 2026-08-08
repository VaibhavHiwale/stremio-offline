import { randomBytes } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { PassThrough } from "node:stream";
import type { Database } from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { signFileToken, verifyFileToken } from "../transport/signedToken.js";

interface ByteRange {
  start: number;
  end: number;
}

/** Parses an RFC 7233 Range header (open-ended, suffix, and multi-range forms). */
export function parseRangeHeader(rangeHeader: string, size: number): ByteRange[] | null {
  const match = /^bytes=(.+)$/.exec(rangeHeader.trim());
  if (!match?.[1]) return null;

  const ranges: ByteRange[] = [];
  for (const spec of match[1].split(",").map((s) => s.trim())) {
    const specMatch = /^(\d*)-(\d*)$/.exec(spec);
    if (!specMatch) return null;
    const [, startStr, endStr] = specMatch;

    let start: number;
    let end: number;
    if (startStr === "" && endStr === "") {
      return null;
    } else if (startStr === "") {
      // Suffix range: last N bytes.
      const suffixLength = Number(endStr);
      if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
      start = Math.max(0, size - suffixLength);
      end = size - 1;
    } else {
      start = Number(startStr);
      end = endStr === "" ? size - 1 : Number(endStr);
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
    ranges.push({ start, end: Math.min(end, size - 1) });
  }

  return ranges.length > 0 ? ranges : null;
}

function buildMultipartByterangesStream(
  filePath: string,
  ranges: ByteRange[],
  size: number,
  boundary: string,
  contentType: string,
): PassThrough {
  const output = new PassThrough();

  (async () => {
    for (const { start, end } of ranges) {
      output.write(`--${boundary}\r\n`);
      output.write(`Content-Type: ${contentType}\r\n`);
      output.write(`Content-Range: bytes ${start}-${end}/${size}\r\n\r\n`);
      await new Promise<void>((resolve, reject) => {
        const rs = createReadStream(filePath, { start, end });
        rs.on("data", (chunk) => output.write(chunk));
        rs.on("end", resolve);
        rs.on("error", reject);
      });
      output.write("\r\n");
    }
    output.end(`--${boundary}--\r\n`);
  })().catch((err) => output.destroy(err instanceof Error ? err : new Error(String(err))));

  return output;
}

export function buildSignedFileUrl(baseUrl: string, secret: string, id: string, ttlSeconds: number): string {
  const { token, expiresAt } = signFileToken(secret, id, ttlSeconds);
  return `${baseUrl}/files/${encodeURIComponent(id)}?t=${token}&exp=${expiresAt}`;
}

export interface FilesRouteDeps {
  db: Database;
  secret: string;
}

/**
 * Range-enabled, signed-token file serving — CLAUDE.md §3 Rules 4 and 8.
 * Reads `download_items.file_path_web_ready` for a row whose status is
 * "ready"; P1 gate is satisfied by hand-inserting such a row for a
 * hand-placed MP4, and P2's catalog/stream handlers reuse the same table.
 */
export function registerFilesRoute(app: FastifyInstance, deps: FilesRouteDeps): void {
  app.get<{ Params: { id: string }; Querystring: { t?: string; exp?: string } }>(
    "/files/:id",
    async (req, reply) => {
      const { id } = req.params;
      const { t, exp } = req.query;
      const expiresAt = Number(exp);

      if (!t || !exp || !verifyFileToken(deps.secret, id, expiresAt, t)) {
        return reply.code(403).send({ error: "invalid or expired token" });
      }

      const row = deps.db
        .prepare("SELECT file_path_web_ready AS filePath, status FROM download_items WHERE id = ?")
        .get(id) as { filePath: string | null; status: string } | undefined;

      if (!row || row.status !== "ready" || !row.filePath) {
        return reply.code(404).send({ error: "not found" });
      }

      let size: number;
      try {
        size = statSync(row.filePath).size;
      } catch {
        return reply.code(404).send({ error: "file missing on disk" });
      }

      reply.header("Accept-Ranges", "bytes");

      const rangeHeader = req.headers.range;
      if (!rangeHeader) {
        reply.code(200);
        reply.header("Content-Type", "video/mp4");
        reply.header("Content-Length", size);
        // Streaming replies MUST be returned here — an async handler that calls
        // reply.send(stream) without returning it races its own resolved
        // promise against the in-flight stream and truncates the response.
        return reply.send(createReadStream(row.filePath));
      }

      const ranges = parseRangeHeader(rangeHeader, size);
      if (!ranges) {
        reply.code(416);
        reply.header("Content-Range", `bytes */${size}`);
        return reply.send();
      }

      if (ranges.length === 1) {
        const range = ranges[0]!;
        reply.code(206);
        reply.header("Content-Type", "video/mp4");
        reply.header("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
        reply.header("Content-Length", range.end - range.start + 1);
        return reply.send(createReadStream(row.filePath, { start: range.start, end: range.end }));
      }

      const boundary = `stremio_offline_${randomBytes(8).toString("hex")}`;
      reply.code(206);
      reply.header("Content-Type", `multipart/byteranges; boundary=${boundary}`);
      return reply.send(buildMultipartByterangesStream(row.filePath, ranges, size, boundary, "video/mp4"));
    },
  );
}
