import assert from "node:assert/strict";
import { test } from "node:test";
import { premiumizeResolver } from "./premiumize.js";

const MAGNET = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Test";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

test("resolves instantly via directdl when the content is already cached", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string | URL) => {
    calls.push(url.toString());
    return jsonResponse({
      status: "success",
      content: [
        { path: "movie.mp4", link: "https://direct.example/movie.mp4", size: 2_000_000_000 },
        { path: "sample.mp4", link: "https://direct.example/sample.mp4", size: 5_000_000 },
      ],
    });
  }) as unknown as typeof fetch;

  const outcome = await premiumizeResolver.resolveMagnet("key", MAGNET, fakeFetch);
  assert.deepEqual(outcome, { status: "ready", directUrl: "https://direct.example/movie.mp4" });
  assert.equal(calls.length, 1, "cached content should resolve in a single directdl call, no transfer created");
});

test("falls back to transfer/create + transfer/list when not instantly cached", async () => {
  const fakeFetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes("/transfer/directdl")) return jsonResponse({ status: "error", message: "not cached" });
    if (u.includes("/transfer/create")) return jsonResponse({ status: "success", id: "t1", name: "Test" });
    if (u.includes("/transfer/list")) {
      return jsonResponse({ status: "success", transfers: [{ id: "t1", status: "running", src: MAGNET }] });
    }
    throw new Error(`unexpected URL: ${u}`);
  }) as unknown as typeof fetch;

  const outcome = await premiumizeResolver.resolveMagnet("key", MAGNET, fakeFetch);
  assert.equal(outcome.status, "pending");
});

test("a failed transfer is a terminal error", async () => {
  const fakeFetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes("/transfer/directdl")) return jsonResponse({ status: "error", message: "not cached" });
    if (u.includes("/transfer/create")) return jsonResponse({ status: "success", id: "t1", name: "Test" });
    if (u.includes("/transfer/list")) {
      return jsonResponse({ status: "success", transfers: [{ id: "t1", status: "error", src: MAGNET, message: "no seeds" }] });
    }
    throw new Error(`unexpected URL: ${u}`);
  }) as unknown as typeof fetch;

  const outcome = await premiumizeResolver.resolveMagnet("key", MAGNET, fakeFetch);
  assert.equal(outcome.status, "error");
  assert.equal((outcome as { retryable: boolean }).retryable, false);
});
