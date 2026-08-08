import Fastify from "fastify";
import { join } from "node:path";
import { buildHealthReport } from "./api/health.js";
import { closeDb, openDb } from "./db/client.js";

const PORT = Number(process.env.PORT ?? 11470);
const HOST = process.env.HOST ?? "0.0.0.0";
const STORAGE_ROOT = process.env.STORAGE_ROOT ?? join(process.cwd(), "data");
const DB_PATH = process.env.DB_PATH ?? join(STORAGE_ROOT, ".offline", "db.sqlite");

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    // Structured JSON logs, no tokens/personal data — see CLAUDE.md §4 Observability.
    redact: ["req.headers.authorization", "req.headers.cookie"],
  },
});

const db = openDb(DB_PATH);

app.get("/health", async (_req, reply) => {
  const report = await buildHealthReport({
    db,
    storageRoot: STORAGE_ROOT,
    activeJobs: 0,
    certStatus: "down",
    certExpiresAt: null,
    debridStatus: "down",
  });
  reply.code(report.status === "down" ? 503 : 200).send(report);
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  try {
    await app.close();
    closeDb();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, "error during shutdown");
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

app
  .listen({ port: PORT, host: HOST })
  .then(() => app.log.info({ port: PORT, host: HOST }, "service listening"))
  .catch((err) => {
    app.log.error({ err }, "failed to start");
    process.exit(1);
  });
