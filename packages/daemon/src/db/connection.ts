import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Create a SQLite database connection.
 * Defaults to in-memory for tests. Pass a file path for persistence.
 */
export function createDb(filePath?: string): Database.Database {
  const db = new Database(filePath ?? ":memory:");

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Owner-only: the store carries queue bodies, grants and session metadata.
  // Sidecars are chmod'd when present (a reopen of an in-use or crashed WAL
  // database); a fresh database's sidecars appear with its first write.
  if (filePath && process.platform !== "win32") {
    for (const suffix of ["", "-wal", "-shm"]) {
      const candidate = `${filePath}${suffix}`;
      if (fs.existsSync(candidate)) fs.chmodSync(candidate, 0o600);
    }
  }

  return db;
}
