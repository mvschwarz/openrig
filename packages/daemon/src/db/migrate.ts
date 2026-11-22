import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export interface Migration {
  name: string;
  sql: string;
}

/** What a migration's recorded content hash is compared against. */
export interface MigrationDrift {
  name: string;
  recorded: string;
  current: string;
}

/** A migration's own SQL, hashed. The ledger records it so an edit after the fact is visible. */
export function migrationContentHash(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/**
 * Run migrations against a database.
 * Tracks applied migrations in a schema_migrations table.
 * Skips already-applied migrations. Applies new ones in order.
 *
 * Each applied migration records the hash of the SQL that was applied. A migration whose file changes
 * afterwards is never re-run — the ledger matches on name — so without this the edit is silent, and
 * the install that already applied it keeps a schema the repository no longer describes. A drift is
 * reported through `onDrift` (and to stderr by default) rather than refused: the migration may have
 * been applied everywhere already, and refusing would stop a daemon that is otherwise fine.
 */
export function migrate(
  db: Database.Database,
  migrations: Migration[],
  onDrift: (drift: MigrationDrift) => void = defaultOnDrift,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Installs created before the hash column exist: add it, and leave their rows' hashes null. A null
  // hash means "what was applied is not known", and it stays unknown. Stamping the current file's hash
  // onto such a row would claim a history this process cannot know: an older daemon may have applied a
  // different version of that SQL, and the first hash-aware start would then report it as applied when
  // it was not.
  const columns = db.prepare("PRAGMA table_info(schema_migrations)").all() as { name: string }[];
  const hasHashColumn = columns.some((column) => column.name === "content_hash");
  if (!hasHashColumn) db.exec("ALTER TABLE schema_migrations ADD COLUMN content_hash TEXT");

  const rows = db
    .prepare("SELECT name, content_hash FROM schema_migrations")
    .all() as { name: string; content_hash: string | null }[];
  const applied = new Map(rows.map((row) => [row.name, row.content_hash]));

  const sorted = [...migrations].sort((a, b) => a.name.localeCompare(b.name));
  const hashOf = new Map(sorted.map((migration) => [migration.name, migrationContentHash(migration.sql)]));

  const applyOne = db.transaction((migration: Migration) => {
    db.exec(migration.sql);
    db.prepare("INSERT INTO schema_migrations (name, content_hash) VALUES (?, ?)").run(
      migration.name,
      hashOf.get(migration.name)!,
    );
  });

  for (const migration of sorted) {
    const recorded = applied.get(migration.name);
    if (recorded === undefined) {
      applyOne(migration);
      continue;
    }
    // Applied before hashes existed: no comparison is possible, so none is made and nothing is
    // recorded. The row keeps its null hash, and the next person can see the history is not known.
    if (recorded === null) continue;
    if (recorded !== hashOf.get(migration.name)) {
      onDrift({ name: migration.name, recorded, current: hashOf.get(migration.name)! });
    }
  }
}

function defaultOnDrift(drift: MigrationDrift): void {
  console.warn(
    `[migrate] ${drift.name} was applied as ${drift.recorded.slice(0, 12)} but the file now hashes ` +
    `${drift.current.slice(0, 12)}; it will not be re-run. Add a new migration for the change.`,
  );
}
