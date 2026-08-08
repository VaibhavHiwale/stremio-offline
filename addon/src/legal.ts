import type { Database } from "better-sqlite3";

/**
 * Mandatory first-run legal notice — CLAUDE.md §1 Scope and legality: "Ship a
 * mandatory first-run legal notice that blocks all functionality until
 * accepted." Acceptance is stored in the single settings row and gates the
 * manifest's configurationRequired flag plus every catalog/meta/stream
 * response.
 */
export function isLegalAccepted(db: Database): boolean {
  const row = db.prepare("SELECT legal_notice_accepted_at AS acceptedAt FROM settings WHERE id = 1").get() as
    | { acceptedAt: string | null }
    | undefined;
  return Boolean(row?.acceptedAt);
}

export function acceptLegalNotice(db: Database): void {
  db.prepare("UPDATE settings SET legal_notice_accepted_at = ? WHERE id = 1").run(new Date().toISOString());
}

export const LEGAL_NOTICE_TEXT =
  "This service downloads content only from sources that your own configured addons and your own " +
  "debrid account already resolve for you. It bundles no scrapers, indexes no content, and refuses " +
  "DRM-protected sources. You are solely responsible for ensuring your use complies with the law in " +
  "your jurisdiction and with the terms of any service you connect.";
