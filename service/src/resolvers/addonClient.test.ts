import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchAddonManifestInfo,
  fetchSeriesVideos,
  fetchStreamsFromAddon,
  guessQuality,
  resolveStreamSource,
} from "./addonClient.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

test("fetchAddonManifestInfo returns name + resources for a valid manifest", async () => {
  const fakeFetch = (async () =>
    jsonResponse({ name: "Test Addon", resources: ["stream", "catalog"] })) as unknown as typeof fetch;
  const info = await fetchAddonManifestInfo("https://fake.example/manifest.json", fakeFetch);
  assert.deepEqual(info, { name: "Test Addon", resources: ["stream", "catalog"] });
});

test("fetchAddonManifestInfo rejects a manifest that doesn't declare the stream resource", async () => {
  const fakeFetch = (async () => jsonResponse({ name: "Catalog Only", resources: ["catalog"] })) as unknown as typeof fetch;
  await assert.rejects(() => fetchAddonManifestInfo("https://fake.example/manifest.json", fakeFetch), /stream/);
});

test("fetchAddonManifestInfo rejects an unreachable/erroring manifest URL", async () => {
  const fakeFetch = (async () => jsonResponse({}, false, 404)) as unknown as typeof fetch;
  await assert.rejects(() => fetchAddonManifestInfo("https://fake.example/manifest.json", fakeFetch), /404/);
});

test("fetchAddonManifestInfo falls back to the manifest URL when the addon has no name", async () => {
  const fakeFetch = (async () => jsonResponse({ resources: ["stream"] })) as unknown as typeof fetch;
  const info = await fetchAddonManifestInfo("https://fake.example/manifest.json", fakeFetch);
  assert.equal(info.name, "https://fake.example/manifest.json");
});

test("fetchStreamsFromAddon hits the expected URL and returns the streams array", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string | URL) => {
    calls.push(url.toString());
    return jsonResponse({ streams: [{ name: "1080p release", infoHash: "abc123" }] });
  }) as unknown as typeof fetch;

  const streams = await fetchStreamsFromAddon("https://fake.example/manifest.json", "series", "tt1:1:2", fakeFetch);
  assert.equal(calls[0], "https://fake.example/stream/series/tt1%3A1%3A2.json");
  assert.equal(streams.length, 1);
  assert.equal(streams[0]!.infoHash, "abc123");
});

test("fetchStreamsFromAddon returns [] (not a throw) when the addon errors or is unreachable", async () => {
  const failing = (async () => jsonResponse({}, false, 500)) as unknown as typeof fetch;
  assert.deepEqual(await fetchStreamsFromAddon("https://fake.example/manifest.json", "series", "tt1:1:2", failing), []);

  const throwing = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  assert.deepEqual(await fetchStreamsFromAddon("https://fake.example/manifest.json", "series", "tt1:1:2", throwing), []);
});

test("fetchSeriesVideos returns the meta's videos array", async () => {
  const fakeFetch = (async () =>
    jsonResponse({ meta: { id: "tt1", videos: [{ id: "tt1:1:1", season: 1, episode: 1 }] } })) as unknown as typeof fetch;
  const videos = await fetchSeriesVideos("https://fake.example/manifest.json", "tt1", fakeFetch);
  assert.deepEqual(videos, [{ id: "tt1:1:1", season: 1, episode: 1 }]);
});

test("fetchSeriesVideos returns null (not []) when the addon doesn't implement meta for this id", async () => {
  const fakeFetch = (async () => jsonResponse({}, false, 404)) as unknown as typeof fetch;
  const videos = await fetchSeriesVideos("https://fake.example/manifest.json", "tt1", fakeFetch);
  assert.equal(videos, null);
});

test("guessQuality recognizes common quality tags and falls back to 'original'", () => {
  assert.equal(guessQuality("Show.S01E02.1080p.WEB-DL"), "1080p");
  assert.equal(guessQuality("Show.S01E02.2160p.HDR"), "4k");
  assert.equal(guessQuality("Show 4K Remux"), "4k");
  assert.equal(guessQuality("Show.S01E02.720p"), "720p");
  assert.equal(guessQuality("Show.S01E02.480p"), "480p");
  assert.equal(guessQuality("Show S01E02 no quality tag"), "original");
});

test("resolveStreamSource: a magnet: url passes straight through", () => {
  const resolved = resolveStreamSource({ url: "magnet:?xt=urn:btih:deadbeef", title: "1080p" });
  assert.deepEqual(resolved, { sourceKind: "magnet", sourceUrl: "magnet:?xt=urn:btih:deadbeef", quality: "1080p" });
});

test("resolveStreamSource: an http(s) url is treated as an already-direct source", () => {
  const resolved = resolveStreamSource({ url: "https://cdn.example/file.mp4", title: "720p" });
  assert.deepEqual(resolved, { sourceKind: "http", sourceUrl: "https://cdn.example/file.mp4", quality: "720p" });
});

test("resolveStreamSource: an infoHash builds a magnet URI with trackers", () => {
  const resolved = resolveStreamSource({
    infoHash: "deadbeefcafe",
    title: "Show.S01E02.1080p",
    sources: ["tracker:udp://tracker.example:80", "dht:abc"],
  });
  assert.equal(resolved?.sourceKind, "magnet");
  assert.equal(resolved?.quality, "1080p");
  assert.ok(resolved?.sourceUrl.startsWith("magnet:?xt=urn:btih:deadbeefcafe"));
  assert.ok(resolved?.sourceUrl.includes("tr=udp%3A%2F%2Ftracker.example%3A80"));
});

test("resolveStreamSource: neither a url nor an infoHash is unusable", () => {
  assert.equal(resolveStreamSource({ name: "Upgrade to premium to unlock this stream" }), null);
});

test("resolveStreamSource: an unrecognized url scheme is unusable", () => {
  assert.equal(resolveStreamSource({ url: "ftp://old.example/file" }), null);
});
