import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { createDbConnection } from "../db/client.js";
import { registerAddonsRoutes } from "./addons.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

function buildTestApp(fetchImpl?: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), "stremio-offline-addons-api-"));
  const db = createDbConnection(join(dir, "db.sqlite"));
  const app = Fastify();
  const deps: Parameters<typeof registerAddonsRoutes>[1] = { db };
  if (fetchImpl) deps.fetchImpl = fetchImpl;
  registerAddonsRoutes(app, deps);
  return { app, db };
}

test("POST /addons registers a valid addon and returns its saved row", async () => {
  const fakeFetch = (async () => jsonResponse({ name: "Fake Addon", resources: ["stream"] })) as unknown as typeof fetch;
  const { app } = buildTestApp(fakeFetch);

  const res = await app.inject({ method: "POST", url: "/addons", payload: { manifestUrl: "https://fake.example/manifest.json" } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.name, "Fake Addon");
  assert.equal(body.manifestUrl, "https://fake.example/manifest.json");
  assert.ok(body.id);
});

test("POST /addons rejects a missing manifestUrl", async () => {
  const { app } = buildTestApp();
  const res = await app.inject({ method: "POST", url: "/addons", payload: {} });
  assert.equal(res.statusCode, 400);
});

test("POST /addons rejects a non-http(s) manifestUrl", async () => {
  const { app } = buildTestApp();
  const res = await app.inject({ method: "POST", url: "/addons", payload: { manifestUrl: "not-a-url" } });
  assert.equal(res.statusCode, 400);
});

test("POST /addons rejects a manifest that doesn't declare the stream resource", async () => {
  const fakeFetch = (async () => jsonResponse({ name: "Catalog Only", resources: ["catalog"] })) as unknown as typeof fetch;
  const { app } = buildTestApp(fakeFetch);

  const res = await app.inject({ method: "POST", url: "/addons", payload: { manifestUrl: "https://fake.example/manifest.json" } });
  assert.equal(res.statusCode, 422);
});

test("POST /addons rejects an unreachable manifest URL", async () => {
  const fakeFetch = (async () => jsonResponse({}, false, 404)) as unknown as typeof fetch;
  const { app } = buildTestApp(fakeFetch);

  const res = await app.inject({ method: "POST", url: "/addons", payload: { manifestUrl: "https://fake.example/manifest.json" } });
  assert.equal(res.statusCode, 422);
});

test("POST /addons twice for the same manifestUrl doesn't duplicate the row", async () => {
  const fakeFetch = (async () => jsonResponse({ name: "Fake Addon", resources: ["stream"] })) as unknown as typeof fetch;
  const { app, db } = buildTestApp(fakeFetch);

  await app.inject({ method: "POST", url: "/addons", payload: { manifestUrl: "https://fake.example/manifest.json" } });
  await app.inject({ method: "POST", url: "/addons", payload: { manifestUrl: "https://fake.example/manifest.json" } });

  const count = (db.prepare("SELECT COUNT(*) AS n FROM source_addons").get() as { n: number }).n;
  assert.equal(count, 1);
});

test("GET /addons lists registered addons", async () => {
  const fakeFetch = (async () => jsonResponse({ name: "Fake Addon", resources: ["stream"] })) as unknown as typeof fetch;
  const { app } = buildTestApp(fakeFetch);
  await app.inject({ method: "POST", url: "/addons", payload: { manifestUrl: "https://fake.example/manifest.json" } });

  const res = await app.inject({ method: "GET", url: "/addons" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { addons: { manifestUrl: string }[] };
  assert.equal(body.addons.length, 1);
  assert.equal(body.addons[0]!.manifestUrl, "https://fake.example/manifest.json");
});
