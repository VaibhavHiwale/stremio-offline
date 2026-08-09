import type { SourceAddon } from "@stremio-offline/shared";
import type { Database } from "better-sqlite3";

const COLUMNS = `id, manifest_url AS manifestUrl, name, added_at AS addedAt`;

/** Registration order — the order addonClient.ts queries them in for a given episode, first usable stream wins. */
export function listSourceAddons(db: Database): SourceAddon[] {
  return db.prepare(`SELECT ${COLUMNS} FROM source_addons ORDER BY added_at ASC`).all() as SourceAddon[];
}

/** Idempotent by `manifest_url` (schema UNIQUE) — re-registering the same addon is a no-op, not a duplicate, same as every other queue/registration mutation in this codebase. */
export function insertSourceAddon(db: Database, addon: { id: string; manifestUrl: string; name: string }): boolean {
  const result = db
    .prepare(`INSERT OR IGNORE INTO source_addons (id, manifest_url, name, added_at) VALUES (?, ?, ?, datetime('now'))`)
    .run(addon.id, addon.manifestUrl, addon.name);
  return result.changes > 0;
}

export function getSourceAddonByManifestUrl(db: Database, manifestUrl: string): SourceAddon | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM source_addons WHERE manifest_url = ?`).get(manifestUrl) as SourceAddon | undefined;
}

export function deleteSourceAddon(db: Database, id: string): boolean {
  const result = db.prepare(`DELETE FROM source_addons WHERE id = ?`).run(id);
  return result.changes > 0;
}
