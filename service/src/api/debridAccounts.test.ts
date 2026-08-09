import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { createDbConnection } from "../db/client.js";
import { registerDebridAccountsRoutes } from "./debridAccounts.js";

function buildTestApp() {
  const dir = mkdtempSync(join(tmpdir(), "stremio-offline-debrid-accounts-api-"));
  const db = createDbConnection(join(dir, "db.sqlite"));
  const app = Fastify();
  registerDebridAccountsRoutes(app, { db });
  return { app, db };
}

test("POST /debrid-accounts creates an account and masks the key in the response", async () => {
  const { app } = buildTestApp();
  const res = await app.inject({
    method: "POST",
    url: "/debrid-accounts",
    payload: { service: "realdebrid", apiKey: "SUPERSECRETKEY1234" },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.service, "realdebrid");
  assert.equal(body.enabled, true);
  assert.ok(body.apiKey.endsWith("1234"));
  assert.ok(!body.apiKey.includes("SUPERSECRET"), "the full key must never be echoed back");
});

test("POST /debrid-accounts rejects an invalid service", async () => {
  const { app } = buildTestApp();
  const res = await app.inject({ method: "POST", url: "/debrid-accounts", payload: { service: "notaservice", apiKey: "x" } });
  assert.equal(res.statusCode, 400);
});

test("POST /debrid-accounts rejects a missing apiKey", async () => {
  const { app } = buildTestApp();
  const res = await app.inject({ method: "POST", url: "/debrid-accounts", payload: { service: "realdebrid" } });
  assert.equal(res.statusCode, 400);
});

test("GET /debrid-accounts lists configured accounts with masked keys", async () => {
  const { app } = buildTestApp();
  await app.inject({ method: "POST", url: "/debrid-accounts", payload: { service: "realdebrid", apiKey: "key-one-value" } });
  await app.inject({ method: "POST", url: "/debrid-accounts", payload: { service: "alldebrid", apiKey: "key-two-value" } });

  const res = await app.inject({ method: "GET", url: "/debrid-accounts" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { accounts: { service: string; apiKey: string }[] };
  assert.equal(body.accounts.length, 2);
  assert.ok(body.accounts.every((a) => !a.apiKey.includes("key-o") && !a.apiKey.includes("key-t")));
});

test("POST /debrid-accounts twice for the same service replaces the key, not duplicates the row", async () => {
  const { app, db } = buildTestApp();
  await app.inject({ method: "POST", url: "/debrid-accounts", payload: { service: "realdebrid", apiKey: "old-key-value" } });
  await app.inject({ method: "POST", url: "/debrid-accounts", payload: { service: "realdebrid", apiKey: "new-key-value" } });

  const count = (db.prepare("SELECT COUNT(*) AS n FROM debrid_accounts").get() as { n: number }).n;
  assert.equal(count, 1);
  const stored = db.prepare("SELECT api_key FROM debrid_accounts WHERE service = 'realdebrid'").get() as { api_key: string };
  assert.equal(stored.api_key, "new-key-value");
});

test("DELETE /debrid-accounts/:service removes it; deleting again 404s", async () => {
  const { app } = buildTestApp();
  await app.inject({ method: "POST", url: "/debrid-accounts", payload: { service: "torbox", apiKey: "key-value" } });

  const first = await app.inject({ method: "DELETE", url: "/debrid-accounts/torbox" });
  assert.equal(first.statusCode, 204);

  const second = await app.inject({ method: "DELETE", url: "/debrid-accounts/torbox" });
  assert.equal(second.statusCode, 404);
});

test("DELETE /debrid-accounts/:service rejects an invalid service name", async () => {
  const { app } = buildTestApp();
  const res = await app.inject({ method: "DELETE", url: "/debrid-accounts/notaservice" });
  assert.equal(res.statusCode, 400);
});
