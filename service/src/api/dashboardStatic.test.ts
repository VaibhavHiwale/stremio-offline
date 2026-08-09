import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { registerDashboardStatic } from "./dashboardStatic.js";

test("serves index.html at / and other files under the dist directory", async () => {
  const distPath = mkdtempSync(join(tmpdir(), "stremio-offline-dashboard-dist-"));
  writeFileSync(join(distPath, "index.html"), "<!doctype html><title>Test Dashboard</title>");
  mkdirSync(join(distPath, "assets"), { recursive: true });
  writeFileSync(join(distPath, "assets", "index.js"), "console.log('hi')");

  const app = Fastify();
  registerDashboardStatic(app, app.log, distPath);
  await app.ready();

  const indexRes = await app.inject({ method: "GET", url: "/" });
  assert.equal(indexRes.statusCode, 200);
  assert.match(indexRes.body, /Test Dashboard/);

  const assetRes = await app.inject({ method: "GET", url: "/assets/index.js" });
  assert.equal(assetRes.statusCode, 200);
  assert.match(assetRes.body, /console\.log/);

  await app.close();
});

test("does not register (and does not throw) when dist/index.html is missing", async () => {
  const distPath = mkdtempSync(join(tmpdir(), "stremio-offline-dashboard-dist-empty-"));
  const app = Fastify();

  assert.doesNotThrow(() => registerDashboardStatic(app, app.log, distPath));
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 404, "no dashboard registered means a plain 404, not a crash");

  await app.close();
});

test("an exact API route registered before the static handler still wins over it", async () => {
  const distPath = mkdtempSync(join(tmpdir(), "stremio-offline-dashboard-dist-collision-"));
  writeFileSync(join(distPath, "index.html"), "<!doctype html><title>Dashboard</title>");
  writeFileSync(join(distPath, "health"), "this file must never be served for /health");

  const app = Fastify();
  app.get("/health", async () => ({ status: "ok" }));
  registerDashboardStatic(app, app.log, distPath);
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: "ok" }, "the API route must win over any same-named static file");

  await app.close();
});
