import assert from "node:assert/strict";
import { test } from "node:test";
import { findLoopbackReferences } from "./noLoopback.js";

test("flags 127.0.0.1 nested in a manifest-shaped object", () => {
  const hits = findLoopbackReferences({
    streams: [{ url: "http://127.0.0.1:11470/files/abc" }],
  });
  assert.equal(hits.length, 1);
  assert.match(hits[0]!, /127\.0\.0\.1/);
});

test("flags localhost case-insensitively", () => {
  const hits = findLoopbackReferences({ url: "https://LOCALHOST:12470/x" });
  assert.equal(hits.length, 1);
});

test("passes a clean LAN/HTTPS manifest", () => {
  const hits = findLoopbackReferences({
    manifest: { id: "x", streams: [{ url: "https://192-168-1-50.abc123.stremio.rocks:12470/files/1" }] },
  });
  assert.deepEqual(hits, []);
});
