import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { migrationsForFullTestDb } from "./helpers/test-app.js";

it.each(["fresh", "at 190", "full test fixture"])("installs activation storage on a database %s", (baseline) => {
  const db = new Database(":memory:");
  try {
    if (baseline === "at 190") {
      migrate(db, ALL_MIGRATIONS.filter(migration => Number(migration.name.slice(0, 3)) <= 190));
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'queue_transfer_ledger'").get()).toBeUndefined();
    }
    migrate(db, baseline === "full test fixture" ? migrationsForFullTestDb : ALL_MIGRATIONS);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'queue_transfer_%' ORDER BY name").pluck().all();
    expect(tables).toEqual([
      "queue_transfer_ledger",
      "queue_transfer_relinquished",
      "queue_transfer_staging",
      "queue_transfer_transition_origins",
    ]);
    expect(db.prepare("SELECT name, [notnull] FROM pragma_table_info('mission_control_actions') WHERE name = 'imported_from'").get())
      .toEqual({ name: "imported_from", notnull: 0 });
  } finally {
    db.close();
  }
});
