import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { createDbConnection } from "../db/client.js";
import { enqueueDownload } from "../db/downloadItems.js";
import { registerWsProgressRoute } from "./wsProgress.js";

// pollMs is always short here — the goal is observable behavior (a client
// gets snapshots reflecting current DB state), not racing the exact instant
// of the connection-open synchronous send against a long poll interval.
const POLL_MS = 30;

// registerWsProgressRoute registers @fastify/websocket itself (see its
// docstring for why — registering it separately here, the way earlier
// drafts of this test did, masked a real bug: it made the plugin's onRoute
// hook active *before* the route was added, which production code's
// timing didn't guarantee, so these tests passed while the real app 500'd
// on every connection).
async function buildTestApp() {
  const dir = mkdtempSync(join(tmpdir(), "stremio-offline-wsprogress-test-"));
  const db = createDbConnection(join(dir, "db.sqlite"));
  const app = Fastify();
  const handle = registerWsProgressRoute(app, { db, pollMs: POLL_MS });
  await app.ready();
  return { app, db, handle };
}

interface WsLike {
  on: (event: "message", cb: (data: unknown) => void) => void;
  close: () => void;
}

/** Buffers every message from the moment it's called (not from `.once()`), so a message delivered before the caller gets around to awaiting can't be silently lost. */
function collectMessages(ws: WsLike): { next: () => Promise<unknown>; waitFor: (predicate: (msg: unknown) => boolean, timeoutMs?: number) => Promise<unknown> } {
  const queue: unknown[] = [];
  const waiters: ((v: unknown) => void)[] = [];
  ws.on("message", (data) => {
    const parsed = JSON.parse(String(data));
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else queue.push(parsed);
  });

  const next = (): Promise<unknown> => {
    if (queue.length > 0) return Promise.resolve(queue.shift());
    return new Promise((resolve) => waiters.push(resolve));
  };

  const waitFor = async (predicate: (msg: unknown) => boolean, timeoutMs = 5000): Promise<unknown> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = await Promise.race([next(), new Promise((r) => setTimeout(() => r(undefined), 200))]);
      if (msg !== undefined && predicate(msg)) return msg;
    }
    throw new Error("waitFor: no matching message within timeout");
  };

  return { next, waitFor };
}

function baseItem(id: string, stremioId: string, title: string) {
  return {
    id,
    stremioId,
    seriesId: null,
    type: "movie" as const,
    title,
    year: 2024,
    season: null,
    episode: null,
    quality: "1080p",
    sourceKind: "http",
    sourceUrl: "https://example.invalid/x",
    storageTargetId: "default",
  };
}

test("a connected client eventually receives a snapshot containing an active item", async () => {
  const { app, db, handle } = await buildTestApp();
  enqueueDownload(db, baseItem("job-1", "tt1", "Test"));

  const ws = await app.injectWS("/ws/progress");
  const messages = collectMessages(ws);
  const msg = (await messages.waitFor((m) => (m as { items: { id: string }[] }).items.length > 0)) as {
    type: string;
    items: { id: string }[];
  };

  assert.equal(msg.type, "snapshot");
  assert.equal(msg.items[0]!.id, "job-1");
  assert.equal(handle.clientCount(), 1);

  handle.stop();
  ws.close();
  await app.close();
});

test("broadcasts on the poll interval reflect DB changes made after the connection opened", async () => {
  const { app, db, handle } = await buildTestApp();
  const ws = await app.injectWS("/ws/progress");
  const messages = collectMessages(ws);

  enqueueDownload(db, baseItem("job-2", "tt2", "Test 2"));

  const msg = (await messages.waitFor((m) => (m as { items: { id: string }[] }).items.some((i) => i.id === "job-2"))) as {
    items: { id: string }[];
  };
  assert.equal(msg.items.length, 1);

  handle.stop();
  ws.close();
  await app.close();
});

test("only in-flight statuses are included, not ready/failed/cancelled/deleted", async () => {
  const { app, db, handle } = await buildTestApp();
  enqueueDownload(db, baseItem("job-ready", "tt3", "Ready"));
  db.prepare("UPDATE download_items SET status = 'ready' WHERE id = 'job-ready'").run();
  enqueueDownload(db, baseItem("job-downloading", "tt4", "Downloading"));
  db.prepare("UPDATE download_items SET status = 'downloading' WHERE id = 'job-downloading'").run();

  const ws = await app.injectWS("/ws/progress");
  const messages = collectMessages(ws);
  const msg = (await messages.waitFor((m) => (m as { items: unknown[] }).items.length > 0)) as { items: { id: string }[] };

  assert.deepEqual(
    msg.items.map((i) => i.id),
    ["job-downloading"],
  );

  handle.stop();
  ws.close();
  await app.close();
});

test("clientCount reflects connected clients", async () => {
  // The close -> clientCount-drops-to-0 side isn't exercised here: the
  // injectWS shim's client-side close() doesn't reliably propagate a
  // server-side 'close' event in this environment (a limitation of the
  // fake in-process transport, not of the route's own close handler,
  // which is a plain `socket.on("close", ...)`). That's covered instead by
  // the E2E run against the real service with a real WebSocket client.
  const { app, handle } = await buildTestApp();
  assert.equal(handle.clientCount(), 0);

  const ws = await app.injectWS("/ws/progress");
  const messages = collectMessages(ws);
  await messages.next(); // the initial empty snapshot
  assert.equal(handle.clientCount(), 1);

  handle.stop();
  ws.close();
  await app.close();
});
