import assert from "node:assert/strict";
import { test } from "node:test";
import { realDebridResolver } from "./realdebrid.js";

const MAGNET = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Test";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

test("resolves a torrent that's already downloaded on first check", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string | URL) => {
    const u = url.toString();
    calls.push(u);
    if (u.endsWith("/torrents/addMagnet")) return jsonResponse({ id: "tor-1" });
    if (u.endsWith("/torrents/info/tor-1")) {
      return jsonResponse({ status: "downloaded", files: [], links: ["https://real-debrid.com/d/abc"] });
    }
    if (u.endsWith("/unrestrict/link")) return jsonResponse({ download: "https://direct.example/movie.mp4" });
    throw new Error(`unexpected URL: ${u}`);
  }) as unknown as typeof fetch;

  const outcome = await realDebridResolver.resolveMagnet("key", MAGNET, fakeFetch);
  assert.deepEqual(outcome, { status: "ready", directUrl: "https://direct.example/movie.mp4" });
  assert.equal(calls.length, 3);
});

test("selects files when the torrent starts in waiting_files_selection, then re-checks", async () => {
  let infoCalls = 0;
  const fakeFetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.endsWith("/torrents/addMagnet")) return jsonResponse({ id: "tor-1" });
    if (u.endsWith("/torrents/selectFiles/tor-1")) return jsonResponse({});
    if (u.endsWith("/torrents/info/tor-1")) {
      infoCalls++;
      if (infoCalls === 1) return jsonResponse({ status: "waiting_files_selection", files: [], links: [] });
      return jsonResponse({ status: "downloaded", files: [], links: ["https://real-debrid.com/d/abc"] });
    }
    if (u.endsWith("/unrestrict/link")) return jsonResponse({ download: "https://direct.example/movie.mp4" });
    throw new Error(`unexpected URL: ${u}`);
  }) as unknown as typeof fetch;

  const outcome = await realDebridResolver.resolveMagnet("key", MAGNET, fakeFetch);
  assert.equal(outcome.status, "ready");
  assert.equal(infoCalls, 2);
});

test("still caching (status downloading, no links yet) is 'pending', not an error", async () => {
  const fakeFetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.endsWith("/torrents/addMagnet")) return jsonResponse({ id: "tor-1" });
    if (u.endsWith("/torrents/info/tor-1")) return jsonResponse({ status: "downloading", files: [], links: [] });
    throw new Error(`unexpected URL: ${u}`);
  }) as unknown as typeof fetch;

  const outcome = await realDebridResolver.resolveMagnet("key", MAGNET, fakeFetch);
  assert.equal(outcome.status, "pending");
});

test("a dead/virus torrent is a terminal error, not retryable", async () => {
  const fakeFetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.endsWith("/torrents/addMagnet")) return jsonResponse({ id: "tor-1" });
    if (u.endsWith("/torrents/info/tor-1")) return jsonResponse({ status: "dead", files: [], links: [] });
    throw new Error(`unexpected URL: ${u}`);
  }) as unknown as typeof fetch;

  const outcome = await realDebridResolver.resolveMagnet("key", MAGNET, fakeFetch);
  assert.equal(outcome.status, "error");
  assert.equal((outcome as { retryable: boolean }).retryable, false);
});

test("a 429 from the API is a retryable error", async () => {
  const fakeFetch = (async () => jsonResponse({}, false, 429)) as unknown as typeof fetch;
  const outcome = await realDebridResolver.resolveMagnet("key", MAGNET, fakeFetch);
  assert.equal(outcome.status, "error");
  assert.equal((outcome as { retryable: boolean }).retryable, true);
});

test("a 401 (bad token) is a terminal error", async () => {
  const fakeFetch = (async () => jsonResponse({}, false, 401)) as unknown as typeof fetch;
  const outcome = await realDebridResolver.resolveMagnet("key", MAGNET, fakeFetch);
  assert.equal(outcome.status, "error");
  assert.equal((outcome as { retryable: boolean }).retryable, false);
});
