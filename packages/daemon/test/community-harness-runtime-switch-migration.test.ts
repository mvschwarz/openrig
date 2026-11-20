import { expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { communityHarnessRuntimeSwitchesSchema } from "../src/db/migrations/179_community_harness_runtime_switches.js";

it("retains history when a switch may name a community harness", () => {
  const db = createDb();
  try {
    migrate(db, ALL_MIGRATIONS.filter(migration => migration.name !== communityHarnessRuntimeSwitchesSchema.name));
    db.exec("INSERT INTO rigs (id, name) VALUES ('rig', 'upgrade'); INSERT INTO nodes (id, rig_id, logical_id) VALUES ('seat', 'rig', 'dev.build');");
    const insert = db.prepare(`INSERT INTO seat_runtime_switches
      (id, node_id, canonical_session, staging_session, predecessor_pane, predecessor_generation, successor_generation, from_runtime, to_runtime, reason, plan_json, deadline_at)
      VALUES (?, 'seat', 'build@upgrade', ?, '%0', 'before', ?, 'codex', ?, 'allowance', '{}', '2026-11-03T03:00:00Z')`);
    insert.run("old", "staging-old", "after-old", "claude-code");
    // Before this migration a harness name is refused by the column itself, not only by the service.
    expect(() => insert.run("refused", "staging-refused", "after-refused", "cursor")).toThrow();
    const before = db.prepare("SELECT * FROM seat_runtime_switches WHERE id = 'old'").get();

    migrate(db, ALL_MIGRATIONS);
    expect(db.prepare("SELECT * FROM seat_runtime_switches WHERE id = 'old'").get()).toEqual(before);
    // One open switch per seat, so the older row is closed before the next one is staged, as a real switch would be.
    db.exec("UPDATE seat_runtime_switches SET phase = 'abandoned' WHERE id = 'old'");
    insert.run("cursor", "staging-cursor", "after-cursor", "cursor");
    expect(db.prepare("SELECT to_runtime FROM seat_runtime_switches WHERE id = 'cursor'").get()).toEqual({ to_runtime: "cursor" });
    // A built-in target still stores exactly as before, and the built-in history is unchanged.
    db.exec("UPDATE seat_runtime_switches SET phase = 'abandoned' WHERE id = 'cursor'");
    insert.run("back", "staging-back", "after-back", "codex");
    expect(db.prepare("SELECT from_runtime, to_runtime FROM seat_runtime_switches WHERE id = 'back'").get())
      .toEqual({ from_runtime: "codex", to_runtime: "codex" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    migrate(db, ALL_MIGRATIONS);
  } finally { db.close(); }
});

it("keeps the permission table's closed list: only the built-in choices the validator writes", () => {
  const db = createDb();
  try {
    migrate(db, ALL_MIGRATIONS);
    db.exec("INSERT INTO rigs (id, name) VALUES ('rig', 'perms'); INSERT INTO nodes (id, rig_id, logical_id) VALUES ('seat', 'rig', 'dev.impl');");
    // The native-permission validator writes only these two, so the column keeps saying exactly that.
    db.prepare("INSERT INTO node_permission_selections (node_id, runtime, mode, actor, reason) VALUES ('seat', 'codex', 'floor', 'me', 'why')").run();
    expect(db.prepare("SELECT runtime FROM node_permission_selections").get()).toEqual({ runtime: "codex" });
    expect(() => db.prepare("INSERT INTO node_permission_selections (node_id, runtime, mode, actor, reason) VALUES ('seat', 'cursor', 'floor', 'me', 'why')").run()).toThrow();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally { db.close(); }
});
