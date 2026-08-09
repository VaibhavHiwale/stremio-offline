import type { DebridAccount, DebridService } from "@stremio-offline/shared";
import type { Database } from "better-sqlite3";

interface RawRow {
  service: DebridService;
  apiKey: string;
  enabled: number;
  addedAt: string;
}

const COLUMNS = `service, api_key AS apiKey, enabled, added_at AS addedAt`;

function toAccount(row: RawRow): DebridAccount {
  return { ...row, enabled: Boolean(row.enabled) };
}

export function listDebridAccounts(db: Database): DebridAccount[] {
  const rows = db.prepare(`SELECT ${COLUMNS} FROM debrid_accounts ORDER BY added_at ASC`).all() as RawRow[];
  return rows.map(toAccount);
}

export function getDebridAccount(db: Database, service: DebridService): DebridAccount | undefined {
  const row = db.prepare(`SELECT ${COLUMNS} FROM debrid_accounts WHERE service = ?`).get(service) as RawRow | undefined;
  return row ? toAccount(row) : undefined;
}

/** Upsert by service — CLAUDE.md §4: idempotent by nature, re-saving the same key (or rotating it) is a plain replace, not a new row. */
export function upsertDebridAccount(db: Database, account: { service: DebridService; apiKey: string; enabled: boolean }): void {
  db.prepare(
    `INSERT INTO debrid_accounts (service, api_key, enabled, added_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(service) DO UPDATE SET api_key = excluded.api_key, enabled = excluded.enabled`,
  ).run(account.service, account.apiKey, account.enabled ? 1 : 0);
}

export function deleteDebridAccount(db: Database, service: DebridService): boolean {
  const result = db.prepare(`DELETE FROM debrid_accounts WHERE service = ?`).run(service);
  return result.changes > 0;
}
