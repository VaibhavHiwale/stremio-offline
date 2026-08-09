import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { createDbConnection } from "../db/client.js";
import { getSettings } from "../db/settings.js";
import { registerSettingsRoutes } from "./settings.js";

function buildTestApp() {
  const dir = mkdtempSync(join(tmpdir(), "stremio-offline-settings-api-"));
  const db = createDbConnection(join(dir, "db.sqlite"));
  const app = Fastify();
  registerSettingsRoutes(app, { db });
  return { app, db };
}

test("GET /settings returns the current settings", async () => {
  const { app } = buildTestApp();
  const res = await app.inject({ method: "GET", url: "/settings" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { maxConcurrentDownloads: number };
  assert.equal(body.maxConcurrentDownloads, 2);
});

test("PATCH /settings updates and returns the new settings", async () => {
  const { app, db } = buildTestApp();
  const res = await app.inject({ method: "PATCH", url: "/settings", payload: { maxConcurrentDownloads: 4 } });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as { maxConcurrentDownloads: number }).maxConcurrentDownloads, 4);
  assert.equal(getSettings(db).maxConcurrentDownloads, 4);
});

test("PATCH /settings rejects an invalid defaultQuality", async () => {
  const { app } = buildTestApp();
  const res = await app.inject({ method: "PATCH", url: "/settings", payload: { defaultQuality: "8k" } });
  assert.equal(res.statusCode, 400);
});

test("PATCH /settings rejects a non-positive maxConcurrentDownloads", async () => {
  const { app } = buildTestApp();
  const res = await app.inject({ method: "PATCH", url: "/settings", payload: { maxConcurrentDownloads: 0 } });
  assert.equal(res.statusCode, 400);
});

test("PATCH /settings silently ignores an attempt to set legalNoticeAcceptedAt directly", async () => {
  const { app, db } = buildTestApp();
  await app.inject({ method: "PATCH", url: "/settings", payload: { legalNoticeAcceptedAt: "2020-01-01T00:00:00.000Z" } });
  assert.equal(getSettings(db).legalNoticeAcceptedAt, null);
});
