import websocketPlugin, { type WebSocket } from "@fastify/websocket";
import type { Database } from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { getActiveItems } from "../db/downloadItems.js";

export interface WsProgressRouteDeps {
  db: Database;
  pollMs?: number;
}

export interface WsProgressHandle {
  stop: () => void;
  clientCount: () => number;
}

/**
 * `WS /ws/progress` — CLAUDE.md §8. Polls the DB on a shared interval
 * (not per-connection — one query serves every connected client) and
 * broadcasts a full snapshot of every in-flight item. Deliberately not
 * wired into every progress-writing call site across P3/P5/P6 (that would
 * mean touching already-tested, working code in several packages for a
 * cosmetic latency improvement); a 1-second poll is imperceptible for a
 * progress bar and keeps this additive-only.
 *
 * **Gotcha**: `@fastify/websocket`'s route-wrapping only takes effect once
 * its own `register()` call has actually completed — calling
 * `app.register(websocketPlugin)` and then immediately (in the same
 * synchronous tick) `app.get(path, { websocket: true }, ...)` silently
 * registers a *plain* HTTP route instead: the `onRoute` hook that rewrites
 * it into a WS handler isn't attached yet, so the eventual upgrade request
 * calls the handler as `(request, reply)`, not `(socket, request)` —
 * `socket.send is not a function` at runtime, but only once a client
 * actually connects, so it slips past typecheck and a naive test that
 * awaits the plugin registration differently than production code does.
 * `app.after(callback)` is the fix: it queues `callback` to run once
 * everything registered before it (the plugin) has finished loading,
 * *without* creating a new encapsulation context the way a nested
 * `app.register(async (instance) => ...)` would — the latter "works" too,
 * but silently moves `injectWS`/`websocketServer` onto the inner child
 * instance instead of `app`, breaking anything (tests, mainly) that
 * expects them on the instance `registerWsProgressRoute` was actually
 * called with.
 */
export function registerWsProgressRoute(app: FastifyInstance, deps: WsProgressRouteDeps): WsProgressHandle {
  const clients = new Set<WebSocket>();

  function snapshotPayload(): string {
    return JSON.stringify({ type: "snapshot", items: getActiveItems(deps.db), timestamp: new Date().toISOString() });
  }

  function broadcast(): void {
    if (clients.size === 0) return;
    const payload = snapshotPayload();
    for (const client of clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  const interval = setInterval(broadcast, deps.pollMs ?? 1000);
  interval.unref();

  app.register(websocketPlugin);
  app.after(() => {
    app.get("/ws/progress", { websocket: true }, (socket) => {
      clients.add(socket);
      socket.send(snapshotPayload()); // immediate first snapshot, don't make a new client wait out the poll interval
      socket.on("close", () => clients.delete(socket));
      socket.on("error", () => clients.delete(socket));
    });
  });

  return {
    stop: () => clearInterval(interval),
    clientCount: () => clients.size,
  };
}
