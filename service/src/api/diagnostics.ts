import type { FastifyInstance } from "fastify";
import { readRecentErrors } from "../observability/errorLog.js";
import { generateWeeklyRollupMarkdown } from "../observability/weeklyRollup.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface DiagnosticsRouteDeps {
  storageRoot: string;
}

/**
 * Computed fresh on every request from the NDJSON log (cheap — just
 * parsing a file), independent of the on-disk `weekly-summary.md` that
 * `observability/weeklyRollup.ts`'s `persistWeeklyRollup` writes on a
 * schedule. Lets anyone check "what's been failing lately" without waiting
 * for the next scheduled write.
 */
export function registerDiagnosticsRoutes(app: FastifyInstance, deps: DiagnosticsRouteDeps): void {
  app.get("/diagnostics/errors", async (_req, reply) => {
    const records = readRecentErrors(deps.storageRoot, WEEK_MS);
    const markdown = generateWeeklyRollupMarkdown(records);
    return reply.send({ generatedAt: new Date().toISOString(), recordCount: records.length, markdown });
  });
}
