import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { recordError } from "../observability/errorLog.js";
import { registerDiagnosticsRoutes } from "./diagnostics.js";

function buildTestApp() {
  const storageRoot = mkdtempSync(join(tmpdir(), "stremio-offline-diagnostics-api-"));
  const app = Fastify();
  registerDiagnosticsRoutes(app, { storageRoot });
  return { app, storageRoot };
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
