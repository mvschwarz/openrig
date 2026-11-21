import Database from "better-sqlite3";

/**
 * Create a SQLite database connection.
 * Defaults to in-memory for tests. Pass a file path for persistence.
 */
export function createDb(filePath?: string): Database.Database {
  const db = new Database(filePath ?? ":memory:");

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Keep temp tables, sort spills and statement journals in memory rather
  // than in a host-chosen temp directory (/var/tmp, /usr/tmp, /tmp). A
  // sandbox can let that directory pass access() yet deny writes to it,
  // which fails nested writes inside a transaction with SQLITE_CANTOPEN.
  db.pragma("temp_store = MEMORY");

  return db;
}
