import assert from "node:assert/strict";
import { test } from "node:test";
import { allDebridResolver } from "./alldebrid.js";

const MAGNET = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Test";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

test("resolves a magnet that's already cached", async () => {
  const fakeFetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes("/magnet/upload")) return jsonResponse({ status: "success", data: { magnets: [{ id: 1, hash: "abc" }] } });
    if (u.includes("/magnet/status")) {
      return jsonResponse({ status: "success", data: { magnets: { status: "Ready", statusCode: 4, links: [{ link: "https://ad/x" }] } } });
    }
    if (u.includes("/link/unlock")) return jsonResponse({ status: "success", data: { link: "https://direct.example/movie.mp4" } });
    throw new Error(`unexpected URL: ${u}`);
  }) as unknown as typeof fetch;

  const outcome = await allDebridResolver.resolveMagnet("key", MAGNET, fakeFetch);
  assert.deepEqual(outcome, { status: "ready", directUrl: "https://direct.example/movie.mp4" });
});

test("no links yet is 'pending'", async () => {
  const fakeFetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes("/magnet/upload")) return jsonResponse({ status: "success", data: { magnets: [{ id: 1, hash: "abc" }] } });
    if (u.includes("/magnet/status")) {
      return jsonResponse({ status: "success", data: { magnets: { status: "Downloading", statusCode: 1, links: [] } } });
    }
    throw new Error(`unexpected URL: ${u}`);
  }) as unknown as typeof fetch;

  const outcome = await allDebridResolver.resolveMagnet("key", MAGNET, fakeFetch);
  assert.equal(outcome.status, "pending");
});

test("an API-level error response is surfaced as an error outcome", async () => {
  const fakeFetch = (async () =>
    jsonResponse({ status: "error", error: { code: "AUTH_BAD_APIKEY", message: "Invalid API key" } })) as unknown as typeof fetch;

  const outcome = await allDebridResolver.resolveMagnet("bad-key", MAGNET, fakeFetch);
  assert.equal(outcome.status, "error");
  assert.equal((outcome as { retryable: boolean }).retryable, false);
});
