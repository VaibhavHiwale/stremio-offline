import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface ServerState {
  ignoreRange: boolean;
  etag: string;
  /** If set, the response is destroyed after this many bytes on the NEXT request only (then reset). */
  truncateAfterBytes: number | null;
  /** If set, the NEXT full (non-truncated) response is written in slow slices instead of one shot. */
  sliceDelayMs: number | null;
}

export interface TestServer {
  url: string;
  close: () => Promise<void>;
  state: ServerState;
}

async function writeBody(
  res: ServerResponse,
  data: Buffer,
  truncateAfter: number | null,
  sliceDelayMs: number | null,
): Promise<void> {
  if (truncateAfter !== null && truncateAfter < data.length) {
    res.write(data.subarray(0, truncateAfter));
    // Simulate a dead connection (kill -9 / cable pulled) — destroy without a clean end.
    res.destroy();
    return;
  }

  if (!sliceDelayMs) {
    res.end(data);
    return;
  }

  const sliceSize = Math.max(1, Math.ceil(data.length / 25));
  for (let i = 0; i < data.length; i += sliceSize) {
    res.write(data.subarray(i, i + sliceSize));
    await new Promise((r) => setTimeout(r, sliceDelayMs));
  }
  res.end();
}

/** Minimal Range-capable HTTP server for exercising the resumable downloader without a real network. */
export function startTestServer(body: Buffer): Promise<TestServer> {
  const state: ServerState = { ignoreRange: false, etag: '"v1"', truncateAfterBytes: null, sliceDelayMs: null };

  const server: Server = createServer((req, res) => {
    const range = req.headers.range;
    const truncateAfter = state.truncateAfterBytes;
    const sliceDelayMs = state.sliceDelayMs;
    state.truncateAfterBytes = null; // one-shot
    state.sliceDelayMs = null; // one-shot

    if (range && !state.ignoreRange) {
      const match = /^bytes=(\d+)-$/.exec(range);
      const start = match?.[1] ? Number(match[1]) : 0;
      const chunk = body.subarray(start);
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${body.length - 1}/${body.length}`,
        "Content-Length": String(chunk.length),
        ETag: state.etag,
      });
      void writeBody(res, chunk, truncateAfter, sliceDelayMs);
      return;
    }

    res.writeHead(200, { "Content-Length": String(body.length), ETag: state.etag });
    void writeBody(res, body, truncateAfter, sliceDelayMs);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/file`,
        // fetch()/undici keep HTTP/1.1 connections alive for reuse, which
        // would otherwise make server.close() hang forever waiting for a
        // socket neither side is going to close first.
        close: () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
        state,
      });
    });
  });
}
