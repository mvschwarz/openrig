import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { getNodeInventory, getNodeInventoryForRigs } from "../src/domain/node-inventory.js";

// Planner choices here do not depend on table size (no ANALYZE statistics), so a small
// fixture shows the plan a large install's daemon runs on every inventory read.
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function seeded(): Database.Database {
  const db = createDb(); databases.push(db);
  migrate(db, ALL_MIGRATIONS);
  db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'rig-one')").run();
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES ('node-held', 'rig-1', 'dev.held', 'claude-code')").run();
  db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES ('rig-1', 'node-held', 'node.held', ?)")
    .run(JSON.stringify({ nodeId: "node-held", reason: "excluded_from_subset" }));
  for (const [id, at] of [["snap-old", "2026-10-01 00:00:00"], ["snap-new", "2026-10-02 00:00:00"]]) {
    db.prepare("INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES (?, 'rig-1', 'manual', 'complete', '{}', ?)").run(id, at);
  }
  return db;
}

/** Every statement the inventory reads prepare, with the plan SQLite runs for it. */
function plansOfInventoryReads(db: Database.Database): Array<{ sql: string; plan: string[] }> {
  const original = db.prepare;
  const statements = new Set<string>();
  db.prepare = function(sql: string) {
    statements.add(sql);
    return original.call(this, sql);
  } as typeof db.prepare;
  try {
    getNodeInventoryForRigs(db, new Set(["rig-1"]));
    getNodeInventory(db, "rig-1");
  } finally { db.prepare = original; }
  return [...statements].filter((sql) => !sql.startsWith("PRAGMA")).map((sql) => ({
    sql,
    plan: (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array((sql.match(/\?/g) ?? []).length).fill("rig-1")) as Array<{ detail: string }>)
      .map((row) => row.detail),
  }));
}

describe("inventory reads stay bounded on a large events log", () => {
  it("reads a held seat's later restores and each rig's latest snapshot through their indexes", () => {
    const plans = plansOfInventoryReads(seeded());
    const laterRestores = plans.filter((p) => p.sql.includes("AND seq > ?"));
    const snapshots = plans.filter((p) => p.sql.includes("FROM snapshots") && p.sql.includes("ORDER BY s2.created_at DESC"));
    expect(laterRestores).toHaveLength(1);
    expect(snapshots).toHaveLength(1);
    expect(laterRestores[0]!.plan).toEqual(["SEARCH events USING INDEX idx_events_restore_rig_seq (rig_id=? AND seq>?)"]);
    expect(snapshots[0]!.plan).not.toContain("SCAN s");
  });

  it("keeps what the reads find", () => {
    const db = seeded();
    expect(getNodeInventory(db, "rig-1")[0]?.heldReason).toBe("excluded_from_subset");
    expect(getNodeInventoryForRigs(db, new Set(["rig-1"])).get("rig-1")).toEqual(getNodeInventory(db, "rig-1"));
    // A later outcome reconciliation is not a restore of the seat; the hold stands.
    db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES ('rig-1', 'node-held', 'restore.outcome_reconciled', ?)")
      .run(JSON.stringify({ nodeId: "node-held", to: "operator_recovered", result: { nodes: [{ nodeId: "node-held" }] } }));
    expect(getNodeInventory(db, "rig-1")[0]?.heldReason).toBe("excluded_from_subset");
    // A later restore that names the held seat supersedes the hold, as before.
    db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES ('rig-1', NULL, 'restore.subset_completed', ?)")
      .run(JSON.stringify({ result: { nodes: [{ nodeId: "node-held", status: "resumed" }] } }));
    expect(getNodeInventory(db, "rig-1")[0]?.heldReason).toBeNull();
  });
});
