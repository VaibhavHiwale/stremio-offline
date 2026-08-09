import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadSubtitle, searchSubtitle } from "./opensubtitles.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

test("finds the highest-download-count result and returns its first file", async () => {
  const fakeFetch = (async () =>
    jsonResponse({
      data: [
        { attributes: { release: "Low", download_count: 5, files: [{ file_id: 1 }] } },
        { attributes: { release: "High", download_count: 500, files: [{ file_id: 2 }] } },
      ],
    })) as unknown as typeof fetch;

  const outcome = await searchSubtitle("key", "0903747", "en", "https://fake.example", fakeFetch);
  assert.deepEqual(outcome, { status: "found", fileId: 2, releaseName: "High" });
});

test("no results is 'not-found', not an error", async () => {
  const fakeFetch = (async () => jsonResponse({ data: [] })) as unknown as typeof fetch;
  const outcome = await searchSubtitle("key", "0903747", "en", "https://fake.example", fakeFetch);
  assert.deepEqual(outcome, { status: "not-found" });
});

test("results with no files attached are skipped", async () => {
  const fakeFetch = (async () =>
    jsonResponse({ data: [{ attributes: { release: "NoFiles", download_count: 100, files: [] } }] })) as unknown as typeof fetch;
  const outcome = await searchSubtitle("key", "0903747", "en", "https://fake.example", fakeFetch);
  assert.deepEqual(outcome, { status: "not-found" });
});

test("a 429 is retryable", async () => {
  const fakeFetch = (async () => jsonResponse({}, false, 429)) as unknown as typeof fetch;
  const outcome = await searchSubtitle("key", "0903747", "en", "https://fake.example", fakeFetch);
  assert.deepEqual(outcome, { status: "error", message: "HTTP 429", retryable: true });
});

test("a 401 is not retryable", async () => {
  const fakeFetch = (async () => jsonResponse({}, false, 401)) as unknown as typeof fetch;
  const outcome = await searchSubtitle("key", "0903747", "en", "https://fake.example", fakeFetch);
  assert.deepEqual(outcome, { status: "error", message: "HTTP 401", retryable: false });
});

test("download requests a link then fetches its content", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string | URL) => {
    const u = url.toString();
    calls.push(u);
    if (u.endsWith("/download")) return jsonResponse({ link: "https://fake.example/dl/abc.srt" });
    if (u === "https://fake.example/dl/abc.srt") {
      return { ok: true, status: 200, text: async () => "1\n00:00:01,000 --> 00:00:02,000\nHi\n" } as unknown as Response;
    }
    throw new Error(`unexpected URL: ${u}`);
  }) as unknown as typeof fetch;

  const outcome = await downloadSubtitle("key", 42, "https://fake.example", fakeFetch);
  assert.equal(outcome.status, "ok");
  assert.equal((outcome as { content: string }).content, "1\n00:00:01,000 --> 00:00:02,000\nHi\n");
  assert.equal(calls.length, 2);
});

test("a failed download request is surfaced as an error", async () => {
  const fakeFetch = (async () => jsonResponse({}, false, 500)) as unknown as typeof fetch;
  const outcome = await downloadSubtitle("key", 42, "https://fake.example", fakeFetch);
  assert.equal(outcome.status, "error");
  assert.equal((outcome as { retryable: boolean }).retryable, true);
});
