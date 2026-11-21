import { expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { ompTuiRuntimeSwitchesSchema } from "../src/db/migrations/175_omp_tui_runtime_switches.js";

it("retains an interrupted runtime switch when upgrading to OMP-capable switches", () => {
  const db = createDb();
  try {
    migrate(db, ALL_MIGRATIONS.filter(migration => migration.name < ompTuiRuntimeSwitchesSchema.name));
    db.exec("INSERT INTO rigs (id, name) VALUES ('rig', 'upgrade'); INSERT INTO nodes (id, rig_id, logical_id) VALUES ('seat', 'rig', 'dev.build');");
    const insert = db.prepare(`INSERT INTO seat_runtime_switches
      (id, node_id, canonical_session, staging_session, predecessor_pane, predecessor_generation, successor_generation, from_runtime, to_runtime, reason, plan_json, deadline_at)
      VALUES (?, 'seat', 'build@upgrade', ?, '%0', 'before', ?, 'codex', ?, 'allowance', '{}', '2026-11-03T03:00:00Z')`);
    insert.run("old", "staging-old", "after-old", "claude-code");
    const before = db.prepare("SELECT * FROM seat_runtime_switches WHERE id = 'old'").get() as Record<string, unknown>;
    migrate(db, ALL_MIGRATIONS);
    expect(db.prepare("SELECT * FROM seat_runtime_switches WHERE id = 'old'").get()).toEqual({ ...before, verified_adoption_generation: null });
    expect(() => insert.run("duplicate", "staging-new", "after-new", "omp-tui")).toThrow();
    db.exec("UPDATE seat_runtime_switches SET phase = 'abandoned' WHERE id = 'old'");
    insert.run("omp-tui", "staging-new", "after-new", "omp-tui");
    expect(db.prepare("SELECT to_runtime FROM seat_runtime_switches WHERE id = 'omp-tui'").get()).toEqual({ to_runtime: "omp-tui" });
    migrate(db, ALL_MIGRATIONS);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally { db.close(); }
});
