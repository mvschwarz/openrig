import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { getNodeInventory, getNodeInventoryForRigs } from "../src/domain/node-inventory.js";

// Without ANALYZE statistics SQLite's join order here does not depend on table size, so a
// small fixture shows the plan a long-lived install's daemon runs on every inventory read.
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function seeded(): Database.Database {
  const db = createDb(); databases.push(db);
  migrate(db, ALL_MIGRATIONS);
  db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'rig-one')").run();
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES ('node-1', 'rig-1', 'dev.impl', 'claude-code')").run();
  db.prepare("INSERT INTO occupant_tenures (id, node_id, generation_ordinal, generation_uuid, kind) VALUES ('tenure-1', 'node-1', 1, 'gen-1', 'fresh')").run();
  db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES ('sess-1', 'node-1', 'dev-impl@rig-one', 'running', 'ready')").run();
  const event = db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES ('rig-1', ?, ?, ?)");
  event.run(null, "restore.completed", JSON.stringify({ result: { nodes: [{ nodeId: "node-1", status: "resumed" }] } }));
  event.run("node-1", "seat.fresh_launched", JSON.stringify({ nodeId: "node-1", sessionId: "sess-1", newGeneration: "gen-1", status: "ready" }));
  for (let i = 0; i < 200; i++) event.run("node-1", "agent.activity", JSON.stringify({ i }));
  return db;
}

/** The fresh-launch reads the inventory actually prepares, with the plan SQLite runs for each. */
function fencePlans(db: Database.Database): string[][] {
  const original = db.prepare;
  const statements = new Set<string>();
  db.prepare = function(sql: string) {
    if (sql.includes("'seat.fresh_launched'")) statements.add(sql);
    return original.call(this, sql);
  } as typeof db.prepare;
  try {
    getNodeInventoryForRigs(db, new Set(["rig-1"]));
    getNodeInventory(db, "rig-1");
  } finally { db.prepare = original; }
  return [...statements].map((sql) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array((sql.match(/\?/g) ?? []).length).fill("rig-1")) as Array<{ detail: string }>)
      .map((row) => row.detail));
}

describe("ready fresh-launch fences", () => {
  it("read each current tenure's fresh launches through idx_events_node_type_seq, never the whole events log", () => {
    const plans = fencePlans(seeded());
    expect(plans).toHaveLength(2); // the fleet and the selected-rig read
    for (const plan of plans) {
      expect(plan).toContain("SEARCH e USING INDEX idx_events_node_type_seq (node_id=? AND type=?)");
      expect(plan).not.toContain("SCAN e");
    }
  });

  it("still fence a restore that started before the ready fresh launch", () => {
    const db = seeded();
    expect(getNodeInventory(db, "rig-1")[0]?.restoreOutcome).toBe("n-a");
    expect(getNodeInventoryForRigs(db, new Set(["rig-1"])).get("rig-1")).toEqual(getNodeInventory(db, "rig-1"));
    // A restore after the launch describes the current occupant and still shows.
    db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES ('rig-1', NULL, 'restore.completed', ?)")
      .run(JSON.stringify({ result: { nodes: [{ nodeId: "node-1", status: "resumed" }] } }));
    expect(getNodeInventory(db, "rig-1")[0]?.restoreOutcome).toBe("resumed");
  });
});
