import type { StorageTarget } from "@stremio-offline/shared";
import type { Database } from "better-sqlite3";

interface RawRow {
  id: string;
  label: string;
  path: string;
  isRemovable: number;
  isDefault: number;
  bytesFree: number;
  bytesTotal: number;
  writable: number;
}

const COLUMNS = `
  id, label, path, is_removable AS isRemovable, is_default AS isDefault,
  bytes_free AS bytesFree, bytes_total AS bytesTotal, writable
`;

function toStorageTarget(row: RawRow): StorageTarget {
  return {
    id: row.id,
    label: row.label,
    path: row.path,
    isRemovable: Boolean(row.isRemovable),
    isDefault: Boolean(row.isDefault),
    bytesFree: row.bytesFree,
    bytesTotal: row.bytesTotal,
    writable: Boolean(row.writable),
  };
}

export function listStorageTargets(db: Database): StorageTarget[] {
  const rows = db.prepare(`SELECT ${COLUMNS} FROM storage_targets ORDER BY is_default DESC, label ASC`).all() as RawRow[];
  return rows.map(toStorageTarget);
}

export function getStorageTarget(db: Database, id: string): StorageTarget | undefined {
  const row = db.prepare(`SELECT ${COLUMNS} FROM storage_targets WHERE id = ?`).get(id) as RawRow | undefined;
  return row ? toStorageTarget(row) : undefined;
}

/** Upsert by id — registering the same path twice (e.g. re-running boot's ensureDefaultTarget) replaces, not duplicates. */
export function upsertStorageTarget(
  db: Database,
  target: { id: string; label: string; path: string; isRemovable: boolean; isDefault: boolean; writable: boolean },
): void {
  db.prepare(
    `INSERT INTO storage_targets (id, label, path, is_removable, is_default, writable)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET label = excluded.label, path = excluded.path,
       is_removable = excluded.is_removable, is_default = excluded.is_default, writable = excluded.writable`,
  ).run(target.id, target.label, target.path, target.isRemovable ? 1 : 0, target.isDefault ? 1 : 0, target.writable ? 1 : 0);
}

export function updateStorageTargetUsage(db: Database, id: string, usage: { bytesFree: number; bytesTotal: number }): void {
  db.prepare(`UPDATE storage_targets SET bytes_free = ?, bytes_total = ? WHERE id = ?`).run(usage.bytesFree, usage.bytesTotal, id);
}

export function deleteStorageTarget(db: Database, id: string): boolean {
  const result = db.prepare(`DELETE FROM storage_targets WHERE id = ?`).run(id);
  return result.changes > 0;
}
