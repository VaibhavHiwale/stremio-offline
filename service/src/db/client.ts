import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "db", "schema.sql");

let db: Database.Database | undefined;

export function openDb(dbFilePath: string): Database.Database {
  if (db) return db;

  mkdirSync(dirname(dbFilePath), { recursive: true });

  const conn = new Database(dbFilePath);
  // Single writer connection, WAL mode, synchronous=NORMAL — see CLAUDE.md §4.
  conn.pragma("journal_mode = WAL");
  conn.pragma("synchronous = NORMAL");
  conn.pragma("foreign_keys = ON");

  const schema = readFileSync(SCHEMA_PATH, "utf8");
  conn.exec(schema);

  db = conn;
  return conn;
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error("Database not initialized — call openDb() before getDb().");
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined;
  }
}

export function dbExistsAt(dbFilePath: string): boolean {
  return existsSync(dbFilePath);
}
