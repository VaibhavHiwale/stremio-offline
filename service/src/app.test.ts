import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildApp } from "./app.js";
import { createDbConnection } from "./db/client.js";
import { errorLogPath } from "./observability/errorLog.js";
import type { RemuxRunnerHandle } from "./queue/remuxRunner.js";
import type { SchedulerHandle } from "./queue/scheduler.js";

function fakeHandle(): SchedulerHandle & RemuxRunnerHandle {
  return { stop: async () => undefined, abortRow: () => false, activeCount: () => 0 };
}

function buildTestApp() {
  const storageRoot = mkdtempSync(join(tmpdir(), "stremio-offline-app-test-"));
  const db = createDbConnection(join(storageRoot, ".offline", "db.sqlite"));
  const app = buildApp({
    db,
    storageRoot,
    fileTokenSecret: "test-secret",
    scheduler: fakeHandle(),
    remuxRunner: fakeHandle(),
    installIdHash: "test-install-hash",
    configuredBaseUrl: "https://example.test",
    getCertInfo: () => ({ status: "down", expiresAt: null }),
    logger: { level: "silent", redact: [] },
  });
  return { app, db, storageRoot };
}

test("an unhandled route exception is recorded to the error log and doesn't leak the raw message on a 500", async () => {
  const { app, db, storageRoot } = buildTestApp();
  db.close(); // any subsequent query against this connection throws for real

  const res = await app.inject({ method: "GET", url: "/downloads/some-id" });

  assert.equal(res.statusCode, 500);
  const body = res.json() as { error: string };
  assert.equal(body.error, "internal server error");

  const logged = JSON.parse(readFileSync(errorLogPath(storageRoot), "utf8").trim());
  assert.equal(logged.component, "rest");
  assert.equal(logged.requestPath, "/downloads/some-id");
  assert.equal(logged.installIdHash, "test-install-hash");
});

test("a normal request that doesn't throw is unaffected by the error handler", async () => {
  const { app } = buildTestApp();
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
});
