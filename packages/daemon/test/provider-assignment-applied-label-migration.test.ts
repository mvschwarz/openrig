import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { migrationsForFullTestDb } from "./helpers/test-app.js";
import { providerAssignmentAppliedLabelSchema } from "../src/db/migrations/181_provider_assignment_applied_label.js";
import { ProviderAccountAssignmentsRepository } from "../src/domain/provider/provider-account-assignments.js";

// #3625: a results table from migration 180 gains the applied label and account, and a result that already carries an
// applied reference takes the label of the switch that gave it, and the account's reference where its own shows it.
describe("migration 181: the applied label and account", () => {
  it("backfills an applied switch's label and account, and leaves a result that applied nothing without them", () => {
    const db = createDb();
    migrate(db, migrationsForFullTestDb.filter((m) => m !== providerAssignmentAppliedLabelSchema));
    db.prepare("INSERT INTO rigs (id, name) VALUES ('r', 'fleet')").run();
    for (const id of ["a", "b", "p"]) db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES (?, 'r', ?, 'codex')").run(id, `dev.${id}`);
    const insert = db.prepare(`INSERT INTO provider_assignment_results (rig_id, provider, node_id, seat, label, kind, detail, activity, codex_home, codex_login, applied_at)
      VALUES ('r', 'codex', ?, ?, ?, ?, 'd', 'idle', ?, ?, 't')`);
    insert.run("a", "a@fleet", "team", "switched", "/homes/a", "team");
    insert.run("b", "b@fleet", "team", "failed_before_effect", null, null);
    // Moved to a prepared home: the seat's own reference doesn't show the account's.
    insert.run("p", "p@fleet", "team", "pending_successor", "/homes/prepared", null);
    db.prepare(`INSERT INTO provider_assignment_results (rig_id, provider, node_id, seat, label, kind, detail, activity, ref_file, ref_kind, applied_at)
      VALUES ('r', 'claude', 'a', 'a@fleet', 'max-2', 'switched', 'd', 'idle', '/keys/max-2', 'api-key', 't')`).run();
    migrate(db, [providerAssignmentAppliedLabelSchema]);
    const repo = new ProviderAccountAssignmentsRepository(db);
    expect(repo.results("r", "codex").map((r) => [r.seat, r.applied?.label ?? null, r.applied?.account ?? null])).toEqual([
      ["a@fleet", "team", { kind: "codex_saved_login", file: null, codexHome: "/homes/a", login: "team" }],
      ["b@fleet", null, null],
      ["p@fleet", "team", null],
    ]);
    expect(repo.results("r", "claude")[0]!.applied?.account).toEqual({ kind: "claude_api_key_file", file: "/keys/max-2", codexHome: null, login: null });
    db.close();
  });
});
