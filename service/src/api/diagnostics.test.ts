import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { createDbConnection } from "../db/client.js";
import { recordError } from "../observability/errorLog.js";
import { registerDiagnosticsRoutes } from "./diagnostics.js";

function buildTestApp(opts: { baseUrl?: string | null; certStatus?: "ok" | "degraded" | "down" } = {}) {
  const storageRoot = mkdtempSync(join(tmpdir(), "stremio-offline-diagnostics-api-"));
  const db = createDbConnection(join(storageRoot, ".offline", "db.sqlite"));
  const app = Fastify();
  registerDiagnosticsRoutes(app, {
    db,
    storageRoot,
    configuredBaseUrl: opts.baseUrl ?? null,
    resolveBaseUrl: () => (opts.baseUrl === undefined ? "https://example.test:12470" : opts.baseUrl),
    getCertInfo: () => ({ status: opts.certStatus ?? "down", expiresAt: null }),
  });
  return { app, storageRoot, db };
}

test("GET /diagnostics/errors reports no errors when the log is empty", async () => {
  const { app } = buildTestApp();
  const res = await app.inject({ method: "GET", url: "/diagnostics/errors" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { recordCount: number; markdown: string };
  assert.equal(body.recordCount, 0);
  assert.match(body.markdown, /No errors recorded/);
});

test("GET /diagnostics/errors reflects recently recorded errors", async () => {
  const { app, storageRoot } = buildTestApp();
  recordError(storageRoot, "scheduler", new Error("boom"), { installIdHash: "x" });
  recordError(storageRoot, "scheduler", new Error("boom again"), { installIdHash: "x" });

  const res = await app.inject({ method: "GET", url: "/diagnostics/errors" });
  const body = res.json() as { recordCount: number; markdown: string };
  assert.equal(body.recordCount, 2);
  assert.match(body.markdown, /scheduler/);
  assert.match(body.markdown, /\| 2 \|/);
});

test("GET /diagnostics renders HTML with the resolved base URL and cert status", async () => {
  const { app } = buildTestApp({ baseUrl: "https://example.test:12470", certStatus: "ok" });
  const res = await app.inject({ method: "GET", url: "/diagnostics" });

  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"] as string, /text\/html/);
  assert.match(res.body, /https:\/\/example\.test:12470/);
  assert.match(res.body, /badge ok/);
});

test("GET /diagnostics shows a fail badge when no base URL can be resolved (loopback-only)", async () => {
  const { app } = buildTestApp({ baseUrl: null });
  const res = await app.inject({ method: "GET", url: "/diagnostics" });

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /could not be resolved/);
});

test("GET /diagnostics reports the manifest as unreachable when the base URL doesn't actually serve one", async () => {
  // Points at a real-looking but unreachable host — the fetch will fail, which is exactly the case this check exists to catch.
  const { app } = buildTestApp({ baseUrl: "https://127.0.0.1:1" });
  const res = await app.inject({ method: "GET", url: "/diagnostics" });

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /badge fail/);
});
