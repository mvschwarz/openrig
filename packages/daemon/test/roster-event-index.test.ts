import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { rosterEventIndexSchema } from "../src/db/migrations/201_roster_event_index.js";
import { readMaterializedRoster } from "../src/domain/snapshot-capture.js";

function readerSql(db: Database.Database): string {
  const spy = vi.spyOn(db, "prepare");
  try {
    readMaterializedRoster(db, "missing");
    const sql = spy.mock.calls.find(([sql]) => sql.includes("topology.roster_recorded"))?.[0];
    expect(sql).toBeDefined();
    return sql!;
  } finally { spy.mockRestore(); }
}

describe("the latest-roster partial index", () => {
  it("keeps every rig's answer on sparse and dense histories while the unchanged reader uses the index", () => {
    const db = createDb();
    try {
      migrate(db, [eventsSchema]);
      const insert = db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)");
      const expected = new Map<string, string[] | null>([["missing", null], ["without-roster", null], ["empty", []]]);
      db.transaction(() => {
        insert.run("without-roster", null, "activity.updated", "{}");
        insert.run("empty", null, "topology.roster_recorded", JSON.stringify({ intendedNodeIds: [] }));
        for (let rig = 0; rig < 64; rig++) {
          const id = `sparse-${rig}`; const nodes = [`node-${rig}`];
          expected.set(id, nodes);
          insert.run(id, null, "topology.roster_recorded", JSON.stringify({ intendedNodeIds: nodes }));
          for (let event = 0; event < 256; event++) insert.run(id, null, "activity.updated", "{}");
        }
        for (let event = 0; event < 2048; event++) {
          insert.run("dense", null, "topology.roster_recorded", JSON.stringify({ intendedNodeIds: [`dense-${event}`] }));
          insert.run("dense", null, "activity.updated", "{}");
        }
        // Roster rows with a node_id are valid input to this reader too.
        insert.run("dense", "non-null-node", "topology.roster_recorded", JSON.stringify({ intendedNodeIds: ["latest"] }));
        expected.set("dense", ["latest"]);
      })();
      const sql = readerSql(db);
      const readAll = () => new Map([...expected.keys()].map(rig => [rig, readMaterializedRoster(db, rig)]));
      expect(readAll()).toEqual(expected);
      const countBefore = db.prepare("SELECT COUNT(*) AS n FROM events").get();
      const beforePlan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("sparse-0") as { detail: string }[];
      expect(beforePlan.some(row => row.detail.includes("idx_events_roster_rig_seq"))).toBe(false);
      migrate(db, [rosterEventIndexSchema]);
      expect(readAll()).toEqual(expected);
      expect(db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual(countBefore);
      for (const rig of expected.keys()) {
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(rig) as { detail: string }[];
        expect(plan.some(row => row.detail.includes("idx_events_roster_rig_seq"))).toBe(true);
      }
      migrate(db, [rosterEventIndexSchema]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name = ?")
        .get(rosterEventIndexSchema.name)).toEqual({ n: 1 });
    } finally { db.close(); }
  });

  it("indexes new rosters and preserves the prior answer after retention deletes the latest", () => {
    const db = createDb();
    try {
      migrate(db, [eventsSchema, rosterEventIndexSchema]);
      const insert = db.prepare("INSERT INTO events (rig_id, type, payload) VALUES (?, ?, ?)");
      insert.run("rig", "topology.roster_recorded", '{"intendedNodeIds":["first"]}');
      const latest = insert.run("rig", "topology.roster_recorded", '{"intendedNodeIds":["second"]}');
      insert.run("rig", "activity.updated", "{}");
      expect(readMaterializedRoster(db, "rig")).toEqual(["second"]);
      db.prepare("DELETE FROM events WHERE seq = ?").run(latest.lastInsertRowid);
      expect(readMaterializedRoster(db, "rig")).toEqual(["first"]);
    } finally { db.close(); }
  });

  it("does not hide a malformed latest roster behind an earlier valid one", () => {
    const db = createDb();
    try {
      migrate(db, [eventsSchema]);
      db.prepare("INSERT INTO events (rig_id, type, payload) VALUES (?, ?, ?)")
        .run("rig", "topology.roster_recorded", '{"intendedNodeIds":["first"]}');
      db.prepare("INSERT INTO events (rig_id, type, payload) VALUES (?, ?, ?)")
        .run("rig", "topology.roster_recorded", "{}");
      expect(() => readMaterializedRoster(db, "rig")).toThrow("malformed authoritative topology roster");
      migrate(db, [rosterEventIndexSchema]);
      expect(() => readMaterializedRoster(db, "rig")).toThrow("malformed authoritative topology roster");
    } finally { db.close(); }
  });
});
