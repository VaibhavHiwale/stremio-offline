import assert from "node:assert/strict";
import { test } from "node:test";
import { debridLinkResolver } from "./debridlink.js";

const MAGNET = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Test";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

test("resolves when files are returned immediately (already cached)", async () => {
  const fakeFetch = (async () =>
    jsonResponse({
      success: true,
      value: {
        id: "s1",
        name: "Test",
        status: 100,
        files: [
          { name: "movie.mp4", size: 2_000_000_000, downloadUrl: "https://direct.example/movie.mp4" },
          { name: "sample.mp4", size: 5_000_000, downloadUrl: "https://direct.example/sample.mp4" },
        ],
      },
    })) as unknown as typeof fetch;

  const outcome = await debridLinkResolver.resolveMagnet("key", MAGNET, fakeFetch);
  assert.deepEqual(outcome, { status: "ready", directUrl: "https://direct.example/movie.mp4" });
});

test("no files yet is 'pending'", async () => {
  const fakeFetch = (async () =>
    jsonResponse({ success: true, value: { id: "s1", name: "Test", status: 0 } })) as unknown as typeof fetch;

  const outcome = await debridLinkResolver.resolveMagnet("key", MAGNET, fakeFetch);
  assert.equal(outcome.status, "pending");
});

test("an unsuccessful response is a non-retryable error", async () => {
  const fakeFetch = (async () => jsonResponse({ success: false, error: "invalid magnet" })) as unknown as typeof fetch;
  const outcome = await debridLinkResolver.resolveMagnet("key", MAGNET, fakeFetch);
  assert.equal(outcome.status, "error");
  assert.equal((outcome as { retryable: boolean }).retryable, false);
});

test("an HTTP 429 is retryable", async () => {
  const fakeFetch = (async () => jsonResponse({}, false, 429)) as unknown as typeof fetch;
  const outcome = await debridLinkResolver.resolveMagnet("key", MAGNET, fakeFetch);
  assert.equal(outcome.status, "error");
  assert.equal((outcome as { retryable: boolean }).retryable, true);
});
