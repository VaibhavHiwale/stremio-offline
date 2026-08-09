import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fetchSubtitlesForItem, parseImdbId } from "./fetchForItem.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

test("parseImdbId strips the leading 'tt' and any series/episode suffix", () => {
  assert.equal(parseImdbId("tt0903747"), "0903747");
  assert.equal(parseImdbId("tt0903747:1:2"), "0903747");
});

test("parseImdbId returns null for anything that isn't a tt-prefixed id", () => {
  assert.equal(parseImdbId("not-an-imdb-id"), null);
  assert.equal(parseImdbId(""), null);
});

test("fetches and writes a sidecar for each requested language, independently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stremio-offline-fetchforitem-test-"));
  const videoPath = join(dir, "movie.mp4");

  const fakeFetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes("languages=en")) {
      return jsonResponse({ data: [{ attributes: { release: "R", download_count: 1, files: [{ file_id: 1 }] } }] });
    }
    if (u.includes("languages=fr")) {
      return jsonResponse({ data: [] }); // not found in French
    }
    if (u.endsWith("/download")) return jsonResponse({ link: "https://fake.example/dl/1.srt" });
    if (u === "https://fake.example/dl/1.srt") {
      return { ok: true, status: 200, text: async () => "English subs" } as unknown as Response;
    }
    throw new Error(`unexpected URL: ${u}`);
  }) as unknown as typeof fetch;

  const results = await fetchSubtitlesForItem(videoPath, "tt0903747", ["en", "fr"], {
    apiKey: "key",
    baseUrl: "https://fake.example",
    fetchImpl: fakeFetch,
  });

  assert.deepEqual(
    results.map((r) => r.lang),
    ["en"],
    "only the language that was actually found should appear in the results",
  );
  assert.equal(existsSync(join(dir, "movie.en.srt")), true);
  assert.equal(readFileSync(join(dir, "movie.en.srt"), "utf8"), "English subs");
  assert.equal(existsSync(join(dir, "movie.fr.srt")), false);
});

test("returns an empty list without any network calls when the stremioId isn't a real IMDb id", async () => {
  let called = false;
  const fakeFetch = (async () => {
    called = true;
    return jsonResponse({});
  }) as unknown as typeof fetch;

  const results = await fetchSubtitlesForItem("movie.mp4", "not-imdb", ["en"], { apiKey: "key", fetchImpl: fakeFetch });
  assert.deepEqual(results, []);
  assert.equal(called, false);
});

test("an API error for one language doesn't stop the others from being tried", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stremio-offline-fetchforitem-test-"));
  const videoPath = join(dir, "movie.mp4");

  const fakeFetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes("languages=en")) return jsonResponse({}, false, 500);
    if (u.includes("languages=fr")) {
      return jsonResponse({ data: [{ attributes: { release: "R", download_count: 1, files: [{ file_id: 1 }] } }] });
    }
    if (u.endsWith("/download")) return jsonResponse({ link: "https://fake.example/dl/1.srt" });
    if (u === "https://fake.example/dl/1.srt") return { ok: true, status: 200, text: async () => "French subs" } as unknown as Response;
    throw new Error(`unexpected URL: ${u}`);
  }) as unknown as typeof fetch;

  const results = await fetchSubtitlesForItem(videoPath, "tt0903747", ["en", "fr"], {
    apiKey: "key",
    baseUrl: "https://fake.example",
    fetchImpl: fakeFetch,
  });

  assert.deepEqual(results.map((r) => r.lang), ["fr"]);
});
