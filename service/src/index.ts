import { join } from "node:path";
import type { SubsystemStatus } from "@stremio-offline/shared";
import { buildApp } from "./app.js";
import { closeDb, openDb } from "./db/client.js";
import { acquireHttpsTransport } from "./transport/certManager.js";
import { loadOrCreateSecret } from "./transport/secretStore.js";

const HTTP_PORT = Number(process.env.HTTP_PORT ?? 11470);
const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? 12470);
const STORAGE_ROOT = process.env.STORAGE_ROOT ?? join(process.cwd(), "data");
const DB_PATH = process.env.DB_PATH ?? join(STORAGE_ROOT, ".offline", "db.sqlite");
const SKIP_CERT_ACQUISITION = process.env.SKIP_CERT_ACQUISITION === "1";

const loggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  // Structured JSON logs, no tokens/personal data — see CLAUDE.md §4 Observability.
  redact: ["req.headers.authorization", "req.headers.cookie"],
};

async function main(): Promise<void> {
  const db = openDb(DB_PATH);
  const fileTokenSecret = loadOrCreateSecret(join(STORAGE_ROOT, ".offline", "file-token-secret"));

  let certStatus: SubsystemStatus = "down";
  let certExpiresAt: string | null = null;
  const getCertInfo = (): { status: SubsystemStatus; expiresAt: string | null } => ({
    status: certStatus,
    expiresAt: certExpiresAt,
  });

  // HTTP listener: localhost-only by design — Rule 2 permits plain HTTP on
  // localhost alone. It exists for local diagnostics, never for LAN clients.
  const httpApp = buildApp({
    db,
    storageRoot: STORAGE_ROOT,
    fileTokenSecret,
    getCertInfo,
    logger: loggerOptions,
  });

  let httpsApp: ReturnType<typeof buildApp> | undefined;

  async function startHttpsIfPossible(): Promise<void> {
    if (SKIP_CERT_ACQUISITION) {
      httpApp.log.warn("SKIP_CERT_ACQUISITION=1 — no HTTPS listener will start; LAN clients cannot be served safely");
      return;
    }

    const { transport, attempts } = await acquireHttpsTransport(STORAGE_ROOT);

    if (!transport) {
      // Fail loudly, never silently fall back to HTTP for LAN/public traffic — Rule 2.
      httpApp.log.error(
        { attempts },
        "could not obtain an HTTPS transport by any configured method — LAN/public clients cannot be served safely until this is fixed",
      );
      return;
    }

    if (transport.method !== "stremio-rocks") {
      // Tunnel transports terminate TLS themselves and forward plain HTTP to us.
      httpApp.log.info({ transport }, "using tunnel transport (not yet implemented)");
      return;
    }

    certStatus = "ok";
    certExpiresAt = transport.notAfter;

    httpsApp = buildApp({
      db,
      storageRoot: STORAGE_ROOT,
      fileTokenSecret,
      getCertInfo,
      logger: loggerOptions,
      https: { key: transport.key, cert: transport.cert },
    });

    await httpsApp.listen({ port: HTTPS_PORT, host: "0.0.0.0" });
    httpsApp.log.info({ port: HTTPS_PORT, domain: transport.domain }, "HTTPS service listening");
  }

  async function shutdown(signal: string): Promise<void> {
    httpApp.log.info({ signal }, "shutting down");
    try {
      await httpApp.close();
      if (httpsApp) await httpsApp.close();
      closeDb();
      process.exit(0);
    } catch (err) {
      httpApp.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await httpApp.listen({ port: HTTP_PORT, host: "127.0.0.1" });
  httpApp.log.info({ port: HTTP_PORT }, "HTTP (localhost-only) service listening");

  // Don't block boot on the cert cascade — it can take real network round trips.
  void startHttpsIfPossible();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("failed to start", err);
  process.exit(1);
});
