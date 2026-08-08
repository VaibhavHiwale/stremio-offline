import type { Database } from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { acceptLegalNotice, isLegalAccepted, LEGAL_NOTICE_TEXT } from "./legal.js";

export interface ConfigureRouteDeps {
  db: Database;
  /** Returns null if no safe (non-loopback) base URL can be resolved yet — see transport/baseUrl.ts in service. */
  resolveBaseUrl: (req: FastifyRequest) => string | null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(body: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Stremio Offline — Configure</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
    .card { border: 1px solid #ccc; border-radius: 8px; padding: 1.5rem; }
    a.button { display: inline-block; padding: 0.6rem 1.2rem; background: #6c3ff2; color: white; border-radius: 6px; text-decoration: none; margin-top: 1rem; }
    code { background: #f0f0f0; padding: 0.2rem 0.4rem; border-radius: 4px; word-break: break-all; }
    button { padding: 0.6rem 1.2rem; border-radius: 6px; border: none; background: #6c3ff2; color: white; cursor: pointer; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

export function registerConfigureRoutes(app: FastifyInstance, deps: ConfigureRouteDeps): void {
  app.get("/configure", async (req: FastifyRequest, reply: FastifyReply) => {
    reply.type("text/html");

    if (!isLegalAccepted(deps.db)) {
      return reply.send(
        page(`
        <div class="card">
          <h1>Before you start</h1>
          <p>${escapeHtml(LEGAL_NOTICE_TEXT)}</p>
          <form method="POST" action="/configure/accept">
            <button type="submit">I understand and accept</button>
          </form>
        </div>
      `),
      );
    }

    const baseUrl = deps.resolveBaseUrl(req);
    if (!baseUrl) {
      return reply.send(
        page(`
        <div class="card">
          <h1>Almost there</h1>
          <p>This service doesn't have a safe (HTTPS, non-loopback) address yet, so it can't hand you an
          install link — see CLAUDE.md §3 Rule 2. Check <code>/health</code> for certificate status, or
          set <code>PUBLIC_BASE_URL</code>.</p>
        </div>
      `),
      );
    }

    const manifestUrl = `${baseUrl}/manifest.json`;
    const deepLink = manifestUrl.replace(/^https?:\/\//, "stremio://");

    return reply.send(
      page(`
      <div class="card">
        <h1>Install Offline Downloads</h1>
        <p>Manifest URL:</p>
        <p><code>${escapeHtml(manifestUrl)}</code></p>
        <a class="button" href="${escapeHtml(deepLink)}">Install in Stremio</a>
      </div>
    `),
    );
  });

  app.post("/configure/accept", async (_req: FastifyRequest, reply: FastifyReply) => {
    acceptLegalNotice(deps.db);
    reply.redirect("/configure");
  });
}
