import assert from "node:assert/strict";
import { test } from "node:test";
import { torBoxResolver } from "./torbox.js";

const MAGNET = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Test";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

test("resolves once the torrent finishes downloading server-side", async () => {
  const fakeFetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes("/torrents/createtorrent")) return jsonResponse({ success: true, data: { torrent_id: 42 } });
    if (u.includes("/torrents/mylist")) {
      return jsonResponse({
        success: true,
        data: [{ id: 42, download_finished: true, files: [{ id: 1, short_name: "movie.mp4", size: 2_000_000_000 }] }],
      });
    }
    if (u.includes("/torrents/requestdl")) return jsonResponse({ success: true, data: "https://direct.example/movie.mp4" });
    throw new Error(`unexpected URL: ${u}`);
  }) as unknown as typeof fetch;

  const outcome = await torBoxResolver.resolveMagnet("key", MAGNET, fakeFetch);
  assert.deepEqual(outcome, { status: "ready", directUrl: "https://direct.example/movie.mp4" });
});

test("still downloading server-side is 'pending'", async () => {
  const fakeFetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes("/torrents/createtorrent")) return jsonResponse({ success: true, data: { torrent_id: 42 } });
    if (u.includes("/torrents/mylist")) {
      return jsonResponse({ success: true, data: [{ id: 42, download_finished: false, files: [] }] });
    }
    throw new Error(`unexpected URL: ${u}`);
  }) as unknown as typeof fetch;

  const outcome = await torBoxResolver.resolveMagnet("key", MAGNET, fakeFetch);
  assert.equal(outcome.status, "pending");
});

test("createtorrent failure is a non-retryable error", async () => {
  const fakeFetch = (async () => jsonResponse({ success: false, detail: "invalid magnet" })) as unknown as typeof fetch;
  const outcome = await torBoxResolver.resolveMagnet("key", MAGNET, fakeFetch);
  assert.equal(outcome.status, "error");
  assert.equal((outcome as { retryable: boolean }).retryable, false);
});
