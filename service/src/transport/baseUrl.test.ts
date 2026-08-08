import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveBaseUrl } from "./baseUrl.js";

test("prefers the explicit configured base URL", () => {
  const url = resolveBaseUrl(
    { headers: { host: "127.0.0.1:11470" }, protocol: "http" },
    "https://192.168.1.50.abc.stremio.rocks:12470/",
  );
  assert.equal(url, "https://192.168.1.50.abc.stremio.rocks:12470");
});

test("derives from a real LAN Host header when nothing is configured", () => {
  const url = resolveBaseUrl(
    { headers: { host: "foo.stremio.rocks:12470" }, protocol: "https" },
    null,
  );
  assert.equal(url, "https://foo.stremio.rocks:12470");
});

test("respects x-forwarded-proto behind a tunnel", () => {
  const url = resolveBaseUrl(
    { headers: { host: "foo.example.com", "x-forwarded-proto": "https" }, protocol: "http" },
    null,
  );
  assert.equal(url, "https://foo.example.com");
});

test("throws rather than emitting a loopback base URL", () => {
  assert.throws(() => resolveBaseUrl({ headers: { host: "127.0.0.1:11470" }, protocol: "http" }, null));
  assert.throws(() => resolveBaseUrl({ headers: { host: "localhost:11470" }, protocol: "http" }, null));
  assert.throws(() => resolveBaseUrl({ headers: {}, protocol: "http" }, null));
});
