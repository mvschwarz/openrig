// The ledger matches an applied migration by name, so editing a migration file after it has been applied
// changes nothing for an install that already ran it: the edit is never re-run and nothing says so. That
// is the state the upgrade path cannot recover from on its own. The ledger now records what was applied,
// and a changed file is reported.

import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate, migrationContentHash, type Migration, type MigrationDrift } from "../src/db/migrate.js";

const first: Migration = { name: "001_alpha.sql", sql: "CREATE TABLE alpha (id TEXT PRIMARY KEY);" };
const second: Migration = { name: "002_beta.sql", sql: "CREATE TABLE beta (id TEXT PRIMARY KEY);" };

function freshDb() {
  return createDb(":memory:");
}

describe("the migration ledger records what it applied", () => {
  it("stores a content hash for each applied migration", () => {
    const db = freshDb();
    try {
      migrate(db, [first, second], () => {});
      const rows = db.prepare("SELECT name, content_hash FROM schema_migrations ORDER BY name").all() as
        { name: string; content_hash: string | null }[];
      expect(rows.map((row) => row.name)).toEqual(["001_alpha.sql", "002_beta.sql"]);
      expect(rows[0]!.content_hash).toBe(migrationContentHash(first.sql));
      expect(rows[1]!.content_hash).toBe(migrationContentHash(second.sql));
    } finally {
      db.close();
    }
  });

  it("applies each migration once and stays quiet when nothing changed", () => {
    const db = freshDb();
    try {
      const drifts: MigrationDrift[] = [];
      migrate(db, [first, second], (drift) => drifts.push(drift));
      migrate(db, [first, second], (drift) => drifts.push(drift));
      expect(drifts).toEqual([]);
      expect((db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n).toBe(2);
    } finally {
      db.close();
    }
  });

  it("reports a migration whose file changed after it was applied, and does not re-run it", () => {
    const db = freshDb();
    try {
      migrate(db, [first, second], () => {});
      const edited: Migration = { name: first.name, sql: `${first.sql}\nALTER TABLE alpha ADD COLUMN note TEXT;` };
      const drifts: MigrationDrift[] = [];
      migrate(db, [edited, second], (drift) => drifts.push(drift));
      expect(drifts).toEqual([{ name: "001_alpha.sql", recorded: migrationContentHash(first.sql), current: migrationContentHash(edited.sql) }]);
      // The edit was not applied: the column the edited SQL would add is absent.
      const columns = db.prepare("PRAGMA table_info(alpha)").all() as { name: string }[];
      expect(columns.map((column) => column.name)).toEqual(["id"]);
    } finally {
      db.close();
    }
  });

  it("leaves a record written before hashes unknown, even when the file has changed since", () => {
    const db = freshDb();
    try {
      // An install from before this change: the table exists, the row exists, there is no hash column.
      // What it applied is version A; the file this process has is version B.
      db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
      db.exec(first.sql);
      db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(first.name);
      const versionB: Migration = { name: first.name, sql: `${first.sql}\nALTER TABLE alpha ADD COLUMN note TEXT;` };

      const drifts: MigrationDrift[] = [];
      migrate(db, [versionB, second], (drift) => drifts.push(drift));

      // No comparison is possible, so none is made: nothing claims version B was applied, and nothing
      // reports drift against a history that is not known.
      expect(drifts).toEqual([]);
      const rows = db.prepare("SELECT name, content_hash FROM schema_migrations ORDER BY name").all() as
        { name: string; content_hash: string | null }[];
      expect(rows).toEqual([
        { name: "001_alpha.sql", content_hash: null },
        { name: "002_beta.sql", content_hash: migrationContentHash(second.sql) },
      ]);
      // Version B was not run: the column it would add is absent.
      const columns = db.prepare("PRAGMA table_info(alpha)").all() as { name: string }[];
      expect(columns.map((column) => column.name)).toEqual(["id"]);
    } finally {
      db.close();
    }
  });

  it("reports drift for a record that did carry a hash", () => {
    const db = freshDb();
    try {
      migrate(db, [first, second], () => {});
      const edited: Migration = { name: first.name, sql: `${first.sql}\nALTER TABLE alpha ADD COLUMN note TEXT;` };
      const drifts: MigrationDrift[] = [];
      migrate(db, [edited, second], (drift) => drifts.push(drift));
      expect(drifts).toEqual([{ name: "001_alpha.sql", recorded: migrationContentHash(first.sql), current: migrationContentHash(edited.sql) }]);
    } finally {
      db.close();
    }
  });
});
