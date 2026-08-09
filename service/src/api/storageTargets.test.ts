import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { createDbConnection } from "../db/client.js";
import { ensureDefaultTarget } from "../storage/targets.js";
import { registerStorageTargetsRoutes } from "./storageTargets.js";

function buildTestApp() {
  const storageRoot = mkdtempSync(join(tmpdir(), "stremio-offline-storage-api-"));
  const db = createDbConnection(join(storageRoot, ".offline", "db.sqlite"));
  const app = Fastify();
  registerStorageTargetsRoutes(app, { db });
  return { app, db, storageRoot };
}

test("GET /storage/targets lists the default target after boot wiring registers it", async () => {
  const { app, db, storageRoot } = buildTestApp();
  ensureDefaultTarget(db, storageRoot);

  const res = await app.inject({ method: "GET", url: "/storage/targets" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { targets: { id: string; path: string }[] };
  assert.equal(body.targets.length, 1);
  assert.equal(body.targets[0]!.path, storageRoot);
});

test("POST /storage/targets registers a new target at a real, reachable path", async () => {
  const { app, storageRoot } = buildTestApp();
  const externalPath = join(storageRoot, "external-usb");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(externalPath, { recursive: true });

  const res = await app.inject({ method: "POST", url: "/storage/targets", payload: { label: "External USB", path: externalPath } });
  assert.equal(res.statusCode, 201);
  const body = res.json() as { id: string; label: string; path: string; isRemovable: boolean };
  assert.equal(body.label, "External USB");
  assert.equal(body.path, externalPath);
  assert.equal(body.isRemovable, true, "targets registered via POST default to removable, unlike the boot-registered default");

  const list = await app.inject({ method: "GET", url: "/storage/targets" });
  assert.equal((list.json() as { targets: unknown[] }).targets.length, 1);
});

test("POST /storage/targets rejects an unreachable path", async () => {
  const { app, storageRoot } = buildTestApp();
  const res = await app.inject({
    method: "POST",
    url: "/storage/targets",
    payload: { label: "Nope", path: join(storageRoot, "does-not-exist-at-all") },
  });
  assert.equal(res.statusCode, 400);
});

test("POST /storage/targets rejects a missing label or path", async () => {
  const { app } = buildTestApp();
  const missingLabel = await app.inject({ method: "POST", url: "/storage/targets", payload: { path: "/tmp" } });
  assert.equal(missingLabel.statusCode, 400);

  const missingPath = await app.inject({ method: "POST", url: "/storage/targets", payload: { label: "X" } });
  assert.equal(missingPath.statusCode, 400);
});

test("GET /storage/usage refreshes usage figures before returning", async () => {
  const { app, db, storageRoot } = buildTestApp();
  ensureDefaultTarget(db, storageRoot);

  const res = await app.inject({ method: "GET", url: "/storage/usage" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { targets: { bytesFree: number; bytesTotal: number }[] };
  assert.equal(body.targets.length, 1);
  assert.ok(body.targets[0]!.bytesFree >= 0);
});
