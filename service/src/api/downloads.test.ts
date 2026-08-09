import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "better-sqlite3";
import type { DownloadItem } from "@stremio-offline/shared";
import { createDbConnection } from "../db/client.js";
import type { RemuxRunnerHandle } from "../queue/remuxRunner.js";
import type { SchedulerHandle } from "../queue/scheduler.js";
import { registerDownloadsRoutes } from "./downloads.js";

function fakeHandle(): { handle: SchedulerHandle & RemuxRunnerHandle; abortedIds: string[] } {
  const abortedIds: string[] = [];
  return {
    abortedIds,
    handle: {
      stop: async () => undefined,
      abortRow: (id: string) => {
        abortedIds.push(id);
        return true;
      },
      activeCount: () => 0,
    },
  };
}

function buildTestApp(): {
  app: FastifyInstance;
  db: Database;
  storageRoot: string;
  scheduler: ReturnType<typeof fakeHandle>;
  remuxRunner: ReturnType<typeof fakeHandle>;
} {
  const storageRoot = mkdtempSync(join(tmpdir(), "stremio-offline-downloads-api-"));
  const db = createDbConnection(join(storageRoot, ".offline", "db.sqlite"));
  const scheduler = fakeHandle();
  const remuxRunner = fakeHandle();
  const app = Fastify();
  registerDownloadsRoutes(app, { db, storageRoot, scheduler: scheduler.handle, remuxRunner: remuxRunner.handle });
  return { app, db, storageRoot, scheduler, remuxRunner };
}

const ENQUEUE_BODY = {
  stremioId: "tt0903747",
  type: "movie",
  title: "The Matrix",
  year: 1999,
  quality: "1080p",
  sourceKind: "http",
  sourceUrl: "https://example.invalid/matrix.mp4",
};

test("POST /downloads creates a new job and returns 201 with the full shape", async () => {
  const { app } = buildTestApp();
  const res = await app.inject({ method: "POST", url: "/downloads", payload: ENQUEUE_BODY });
  assert.equal(res.statusCode, 201);
  const body = res.json() as DownloadItem;
  assert.equal(body.status, "queued");
  assert.equal(body.title, "The Matrix");
  assert.ok(body.id);
});

test("POST /downloads twice with the same stremioId+quality is idempotent — same id, second call returns 200", async () => {
  const { app } = buildTestApp();
  const first = await app.inject({ method: "POST", url: "/downloads", payload: ENQUEUE_BODY });
  const second = await app.inject({ method: "POST", url: "/downloads", payload: ENQUEUE_BODY });

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 200);
  assert.equal((first.json() as DownloadItem).id, (second.json() as DownloadItem).id);
});

test("POST /downloads rejects a body missing required fields", async () => {
  const { app } = buildTestApp();
  const res = await app.inject({ method: "POST", url: "/downloads", payload: { title: "Missing everything else" } });
  assert.equal(res.statusCode, 400);
});

test("GET /downloads lists everything, and ?status filters", async () => {
  const { app } = buildTestApp();
  await app.inject({ method: "POST", url: "/downloads", payload: ENQUEUE_BODY });
  await app.inject({ method: "POST", url: "/downloads", payload: { ...ENQUEUE_BODY, stremioId: "tt2", quality: "720p" } });

  const all = await app.inject({ method: "GET", url: "/downloads" });
  assert.equal((all.json() as { items: DownloadItem[] }).items.length, 2);

  const filtered = await app.inject({ method: "GET", url: "/downloads?status=queued" });
  assert.equal((filtered.json() as { items: DownloadItem[] }).items.length, 2);

  const none = await app.inject({ method: "GET", url: "/downloads?status=ready" });
  assert.equal((none.json() as { items: DownloadItem[] }).items.length, 0);
});

test("GET /downloads/:id 404s for an unknown id", async () => {
  const { app } = buildTestApp();
  const res = await app.inject({ method: "GET", url: "/downloads/no-such-id" });
  assert.equal(res.statusCode, 404);
});

test("PATCH /downloads/:id pause: queued -> paused, and interrupts the live scheduler job", async () => {
  const { app, scheduler } = buildTestApp();
  const created = await app.inject({ method: "POST", url: "/downloads", payload: ENQUEUE_BODY });
  const id = (created.json() as DownloadItem).id;

  const res = await app.inject({ method: "PATCH", url: `/downloads/${id}`, payload: { action: "pause" } });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as DownloadItem).status, "paused");
  assert.deepEqual(scheduler.abortedIds, [id]);
});

test("PATCH /downloads/:id pause on a ready row is rejected with 409", async () => {
  const { app, db } = buildTestApp();
  const created = await app.inject({ method: "POST", url: "/downloads", payload: ENQUEUE_BODY });
  const id = (created.json() as DownloadItem).id;
  db.prepare("UPDATE download_items SET status = 'ready' WHERE id = ?").run(id);

  const res = await app.inject({ method: "PATCH", url: `/downloads/${id}`, payload: { action: "pause" } });
  assert.equal(res.statusCode, 409);
});

test("PATCH /downloads/:id retry: failed -> queued, resets attempt_count", async () => {
  const { app, db } = buildTestApp();
  const created = await app.inject({ method: "POST", url: "/downloads", payload: ENQUEUE_BODY });
  const id = (created.json() as DownloadItem).id;
  db.prepare("UPDATE download_items SET status = 'failed', attempt_count = 5, last_error = 'boom' WHERE id = ?").run(id);

  const res = await app.inject({ method: "PATCH", url: `/downloads/${id}`, payload: { action: "retry" } });
  assert.equal(res.statusCode, 200);
  const body = res.json() as DownloadItem;
  assert.equal(body.status, "queued");
  assert.equal(body.attemptCount, 0);
  assert.equal(body.lastError, null);
});

test("PATCH /downloads/:id priority updates the row", async () => {
  const { app } = buildTestApp();
  const created = await app.inject({ method: "POST", url: "/downloads", payload: ENQUEUE_BODY });
  const id = (created.json() as DownloadItem).id;

  const res = await app.inject({ method: "PATCH", url: `/downloads/${id}`, payload: { priority: 7 } });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as DownloadItem).priority, 7);
});

test("PATCH /downloads/:id 404s for an unknown id", async () => {
  const { app } = buildTestApp();
  const res = await app.inject({ method: "PATCH", url: "/downloads/no-such-id", payload: { action: "pause" } });
  assert.equal(res.statusCode, 404);
});

test("DELETE /downloads/:id on a queued row cancels it; deleting twice is idempotent", async () => {
  const { app } = buildTestApp();
  const created = await app.inject({ method: "POST", url: "/downloads", payload: ENQUEUE_BODY });
  const id = (created.json() as DownloadItem).id;

  const first = await app.inject({ method: "DELETE", url: `/downloads/${id}` });
  assert.equal(first.statusCode, 200);
  assert.equal((first.json() as DownloadItem).status, "cancelled");

  const second = await app.inject({ method: "DELETE", url: `/downloads/${id}` });
  assert.equal(second.statusCode, 200, "deleting an already-cancelled row must not error");
  assert.equal((second.json() as DownloadItem).status, "cancelled");
});

test("DELETE /downloads/:id on a ready row marks it deleted and removes the on-disk file", async () => {
  const { app, db, storageRoot } = buildTestApp();
  const created = await app.inject({ method: "POST", url: "/downloads", payload: ENQUEUE_BODY });
  const id = (created.json() as DownloadItem).id;

  const libraryDir = join(storageRoot, "Movies", "The Matrix (1999)");
  mkdirSync(libraryDir, { recursive: true });
  const filePath = join(libraryDir, "The Matrix (1999).mp4");
  writeFileSync(filePath, "fake mp4 bytes");
  db.prepare("UPDATE download_items SET status = 'ready', file_path_web_ready = ? WHERE id = ?").run(filePath, id);

  const res = await app.inject({ method: "DELETE", url: `/downloads/${id}` });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as DownloadItem).status, "deleted");
  assert.equal(existsSync(filePath), false, "the published file must be removed, not left as an orphan");
});

test("DELETE /downloads/:id on a downloading row aborts the live scheduler job", async () => {
  const { app, db, scheduler } = buildTestApp();
  const created = await app.inject({ method: "POST", url: "/downloads", payload: ENQUEUE_BODY });
  const id = (created.json() as DownloadItem).id;
  db.prepare("UPDATE download_items SET status = 'downloading' WHERE id = ?").run(id);

  const res = await app.inject({ method: "DELETE", url: `/downloads/${id}` });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as DownloadItem).status, "cancelled");
  assert.deepEqual(scheduler.abortedIds, [id]);
});

test("DELETE /downloads/:id on a remuxing row aborts the live remux job", async () => {
  const { app, db, remuxRunner } = buildTestApp();
  const created = await app.inject({ method: "POST", url: "/downloads", payload: ENQUEUE_BODY });
  const id = (created.json() as DownloadItem).id;
  db.prepare("UPDATE download_items SET status = 'remuxing' WHERE id = ?").run(id);

  const res = await app.inject({ method: "DELETE", url: `/downloads/${id}` });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(remuxRunner.abortedIds, [id]);
});

test("DELETE /downloads/:id 404s for an unknown id", async () => {
  const { app } = buildTestApp();
  const res = await app.inject({ method: "DELETE", url: "/downloads/no-such-id" });
  assert.equal(res.statusCode, 404);
});

test("POST /downloads/:id/progress records the position and returns the full item", async () => {
  const { app } = buildTestApp();
  const created = await app.inject({ method: "POST", url: "/downloads", payload: ENQUEUE_BODY });
  const id = (created.json() as DownloadItem).id;

  const res = await app.inject({ method: "POST", url: `/downloads/${id}/progress`, payload: { positionSeconds: 120 } });
  assert.equal(res.statusCode, 200);
  const body = res.json() as DownloadItem;
  assert.equal(body.lastPositionSeconds, 120);
  assert.equal(body.watched, false, "no durationSeconds supplied, so the watched threshold can't be evaluated");
});

test("POST /downloads/:id/progress marks watched once position crosses 90% of the reported duration", async () => {
  const { app } = buildTestApp();
  const created = await app.inject({ method: "POST", url: "/downloads", payload: ENQUEUE_BODY });
  const id = (created.json() as DownloadItem).id;

  const notYet = await app.inject({
    method: "POST",
    url: `/downloads/${id}/progress`,
    payload: { positionSeconds: 80, durationSeconds: 100 },
  });
  assert.equal((notYet.json() as DownloadItem).watched, false);

  const crossed = await app.inject({
    method: "POST",
    url: `/downloads/${id}/progress`,
    payload: { positionSeconds: 91, durationSeconds: 100 },
  });
  assert.equal((crossed.json() as DownloadItem).watched, true);
});

test("POST /downloads/:id/progress never un-marks watched once set", async () => {
  const { app } = buildTestApp();
  const created = await app.inject({ method: "POST", url: "/downloads", payload: ENQUEUE_BODY });
  const id = (created.json() as DownloadItem).id;

  await app.inject({ method: "POST", url: `/downloads/${id}/progress`, payload: { positionSeconds: 95, durationSeconds: 100 } });
  const rewound = await app.inject({
    method: "POST",
    url: `/downloads/${id}/progress`,
    payload: { positionSeconds: 5, durationSeconds: 100 },
  });
  assert.equal((rewound.json() as DownloadItem).watched, true, "rewinding to the start after finishing must not un-mark watched");
});

test("POST /downloads/:id/progress rejects a missing/invalid positionSeconds", async () => {
  const { app } = buildTestApp();
  const created = await app.inject({ method: "POST", url: "/downloads", payload: ENQUEUE_BODY });
  const id = (created.json() as DownloadItem).id;

  const missing = await app.inject({ method: "POST", url: `/downloads/${id}/progress`, payload: {} });
  assert.equal(missing.statusCode, 400);

  const negative = await app.inject({ method: "POST", url: `/downloads/${id}/progress`, payload: { positionSeconds: -5 } });
  assert.equal(negative.statusCode, 400);
});

test("POST /downloads/:id/progress 404s for an unknown id", async () => {
  const { app } = buildTestApp();
  const res = await app.inject({ method: "POST", url: "/downloads/no-such-id/progress", payload: { positionSeconds: 10 } });
  assert.equal(res.statusCode, 404);
});
