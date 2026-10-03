import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { inventoryEventIndexesSchema } from "../src/db/migrations/084_inventory_event_indexes.js";
import { getNodeInventory, getNodeInventoryForRigs } from "../src/domain/node-inventory.js";

const THROUGH = ALL_MIGRATIONS.filter(m => m.name <= inventoryEventIndexesSchema.name);
const BEFORE = THROUGH.filter(m => m.name < inventoryEventIndexesSchema.name);
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function database() { const db = createDb(); databases.push(db); return db; }
function emit(db: Database.Database, rig: string | null, node: string | null, type: string, payload: unknown) {
  db.prepare("INSERT INTO events(rig_id,node_id,type,payload,created_at) VALUES(?,?,?,?,?)")
    .run(rig, node, type, JSON.stringify(payload), "2026-09-12 00:00:00");
}
function seed(db: Database.Database) {
  for (const id of ["a", "b"]) {
    db.prepare("INSERT INTO rigs(id,name) VALUES(?,?)").run(id, id);
    db.prepare("INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES(?,?,?,?)").run(id, id, "worker", "codex");
  }
  emit(db, "a", null, "restore.completed", { result: { nodes: [{ nodeId: "a", status: "failed" }] } });
  emit(db, "b", null, "restore.subset_completed", { result: { nodes: [{ nodeId: "b", status: "resumed" }] } });
  emit(db, "a", "a", "restore.outcome_reconciled", { nodeId: "a", to: "operator_recovered" });
  emit(db, "a", "a", "node.startup_challenged", { challengeId: "old" });
  emit(db, "a", "a", "node.startup_proof_verified", { challengeId: "old" });
  emit(db, "a", "a", "node.startup_challenged", { challengeId: "new" });
  emit(db, "a", "a", "node.startup_proof_rejected", { challengeId: "new" });
  emit(db, "b", "b", "node.startup_proof_skipped", { reason: "not_selected" });
  // Malformed history remains present; the existing fold skips it.
  db.prepare("INSERT INTO events(rig_id,type,payload) VALUES('a','restore.completed','{')").run();
  db.transaction(() => {
    for (let i = 0; i < 2000; i++) emit(db, i % 2 ? "a" : "b", null, "agent.activity", { i });
  })();
}
function rows(db: Database.Database) { return db.prepare("SELECT * FROM events ORDER BY seq").all(); }
function projection(db: Database.Database) {
  return { all: [...getNodeInventoryForRigs(db, new Set(["a", "b"]))], selected: getNodeInventory(db, "a") };
}
function plansFromActualReads(db: Database.Database) {
  const original = db.prepare;
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  db.prepare = function(sql: string) {
    const statement = original.call(this, sql);
    if (sql.includes("restore.outcome_reconciled") || sql.includes("node.startup_challenged")) {
      const all = statement.all;
      statement.all = function(...args: unknown[]) {
        calls.push({ sql, args });
        return Reflect.apply(all, this, args);
      };
    }
    return statement;
  } as typeof db.prepare;
  try { projection(db); } finally { db.prepare = original; }
  return calls.map(({ sql, args }) => ({
    sql, args,
    detail: JSON.stringify(db.prepare("EXPLAIN QUERY PLAN " + sql).all(...args)),
  }));
}
function expectIndexed(db: Database.Database) {
  const plans = plansFromActualReads(db);
  const restore = plans.filter(p => p.sql.includes("restore.outcome_reconciled"));
  expect(restore.find(p => !p.args.length)?.detail).toContain("idx_events_restore_seq");
  expect(restore.find(p => p.args.length)?.detail).toContain("idx_events_restore_rig_seq");
  // Attempt binding must not reintroduce a scan of unrelated activity events.
  for (const plan of restore) expect(plan.detail).toContain("idx_events_node_type_seq");
  expect(plans.find(p => p.sql.includes("node.startup_challenged"))?.detail).toContain("idx_events_startup_node_seq");
}

describe("084 inventory event read indexes", () => {
  it("upgrades the actual read plans without changing history, membership or newest-event meaning", () => {
    const db = database(); migrate(db, BEFORE); seed(db);
    const value = projection(db), history = rows(db);
    expect(value.selected[0]?.restoreOutcome).toBe("operator_recovered");
    expect(plansFromActualReads(db).some(p => p.detail.includes('"SCAN events"'))).toBe(true);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all() as { name: string }[];
    migrate(db, THROUGH);
    expectIndexed(db);
    expect(rows(db)).toEqual(history);
    expect(projection(db)).toEqual(value);
    const added = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all() as { name: string }[])
      .map(r => r.name).filter(name => !indexes.some(r => r.name === name));
    expect(added).toEqual(["idx_events_restore_rig_seq", "idx_events_restore_seq", "idx_events_startup_node_seq"]);
    // Later real writes still change the projection; the indexes are not a cache.
    emit(db, "a", null, "restore.completed", { result: { nodes: [{ nodeId: "a", status: "rebuilt" }] } });
    expect(getNodeInventory(db, "a")[0]?.restoreOutcome).toBe("rebuilt");
    expect(rows(db).slice(0, history.length)).toEqual(history);
  });

  it("fresh schema and idempotent replay preserve the same reads", () => {
    const db = database(); migrate(db, THROUGH); seed(db); expectIndexed(db);
    const before = { value: projection(db), history: rows(db), migrations: db.prepare("SELECT * FROM schema_migrations ORDER BY name").all() };
    migrate(db, THROUGH);
    expect({ value: projection(db), history: rows(db), migrations: db.prepare("SELECT * FROM schema_migrations ORDER BY name").all() }).toEqual(before);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
