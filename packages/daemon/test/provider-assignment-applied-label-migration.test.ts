import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { migrationsForFullTestDb } from "./helpers/test-app.js";
import { providerAssignmentAppliedLabelSchema } from "../src/db/migrations/181_provider_assignment_applied_label.js";
import { ProviderAccountAssignmentsRepository } from "../src/domain/provider/provider-account-assignments.js";

// #3625: a results table from migration 180 gains the applied label, and a result that already carries an applied
// reference takes the label of the switch that gave it.
describe("migration 181: the applied label", () => {
  it("backfills the label of an applied switch, and leaves a result that applied nothing without one", () => {
    const db = createDb();
    migrate(db, migrationsForFullTestDb.filter((m) => m !== providerAssignmentAppliedLabelSchema));
    db.prepare("INSERT INTO rigs (id, name) VALUES ('r', 'fleet')").run();
    for (const id of ["a", "b"]) db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES (?, 'r', ?, 'codex')").run(id, `dev.${id}`);
    const insert = db.prepare(`INSERT INTO provider_assignment_results (rig_id, provider, node_id, seat, label, kind, detail, activity, codex_home, codex_login, applied_at)
      VALUES ('r', 'codex', ?, ?, ?, ?, 'd', 'idle', ?, ?, 't')`);
    insert.run("a", "a@fleet", "team", "switched", "/homes/a", "team");
    insert.run("b", "b@fleet", "team", "failed_before_effect", null, null);
    migrate(db, [providerAssignmentAppliedLabelSchema]);
    const results = new ProviderAccountAssignmentsRepository(db).results("r", "codex");
    expect(results.map((r) => [r.seat, r.applied?.label ?? null])).toEqual([["a@fleet", "team"], ["b@fleet", null]]);
    db.close();
  });
});
