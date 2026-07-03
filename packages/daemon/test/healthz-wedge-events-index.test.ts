import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { eventsNodeTypeIndexSchema } from "../src/db/migrations/047_events_node_type_index.js";
import { deriveOriented } from "../src/domain/startup-proof.js";

/**
 * OPR.0.4.3 hotfix proof — the daemon /healthz-wedge cure (migration 047).
 *
 * The wedge (root-caused from a live 98-100% CPU sample) was a per-node reverse
 * scan of the append-only `events` table with no supporting index — a full
 * backward table walk per node on every 3s `GET /api/ps` poll. These tests
 * prove that migration 047 turns the two hot derive queries from a full-table
 * SCAN (the wedge) into a BOUNDED INDEXED SEEK, and that the query behaviour is
 * unchanged (index-only fix — no logic change to the derive functions).
 */

// The two hot queries, VERBATIM from the derive functions (must stay in sync).
const ORIENTED_SQL =
  "SELECT type, payload, seq FROM events WHERE node_id = ? AND type IN ('node.startup_challenged','node.startup_proof_verified','node.startup_proof_rejected') ORDER BY seq DESC";
const RESTORE_SQL =
  "SELECT type, payload, seq FROM events WHERE rig_id = ? AND type IN ('restore.completed', 'restore.subset_completed', 'restore.outcome_reconciled') ORDER BY seq DESC";

function mkDb(withIndex: boolean): Database.Database {
  const db = new Database(":memory:");
  migrate(db, withIndex ? [eventsSchema, eventsNodeTypeIndexSchema] : [eventsSchema]);
  return db;
}

function insertEvent(
  db: Database.Database,
  ev: { rigId: string | null; nodeId: string | null; type: string; payload: unknown },
): void {
  db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)").run(
    ev.rigId,
    ev.nodeId,
    ev.type,
    JSON.stringify(ev.payload),
  );
}

function planFor(db: Database.Database, sql: string, param: string): string {
  const rows = db.prepare("EXPLAIN QUERY PLAN " + sql).all(param) as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join(" | ");
}

describe("OPR.0.4.3 healthz-wedge — migration 047 events indexes", () => {
  describe("query plan: full SCAN (the wedge) → bounded indexed SEEK", () => {
    it("WITHOUT the index, deriveOriented's query is a full-table SCAN of events (the wedge)", () => {
      const db = mkDb(false);
      const plan = planFor(db, ORIENTED_SQL, "node-x");
      expect(plan).toMatch(/SCAN events/i);
      expect(plan).not.toMatch(/idx_events_node_type_seq/);
      db.close();
    });

    it("WITH migration 047, deriveOriented's query uses idx_events_node_type_seq (no full SCAN)", () => {
      const db = mkDb(true);
      const plan = planFor(db, ORIENTED_SQL, "node-x");
      expect(plan).toMatch(/idx_events_node_type_seq/);
      expect(plan).not.toMatch(/SCAN events/i); // a SEARCH via index, never a full-table SCAN
      db.close();
    });

    it("deriveRestoreOutcome is rig-scoped — it rides the existing idx_events_rig_seq (rig-bounded, NOT the full-table wedge); a (rig_id,type,seq) index goes unused (planner prefers rig_seq for the seq ordering), so it is second-order, addressed by the follow-on N+1 collapse, not this hotfix", () => {
      const db = mkDb(true);
      const plan = planFor(db, RESTORE_SQL, "rig-x");
      expect(plan).toMatch(/idx_events_rig_seq/); // rig-bounded seek, not a full-table SCAN
      expect(plan).not.toMatch(/SCAN events/i);
      db.close();
    });
  });

  describe("deriveOriented correctness is unchanged (index-only fix) — even buried under many other-node events", () => {
    const RIG = "rig-1";
    const TARGET = "node-target";

    function seedNoise(db: Database.Database, n: number): void {
      // Many newer agent.activity events for OTHER nodes — the rows that made
      // the pre-index reverse scan walk the whole table for a silent target.
      for (let i = 0; i < n; i++) {
        insertEvent(db, { rigId: RIG, nodeId: `other-${i % 7}`, type: "agent.activity", payload: { state: "running" } });
      }
    }

    it("returns 'n-a' when the node was never challenged", () => {
      const db = mkDb(true);
      seedNoise(db, 300);
      expect(deriveOriented(db, TARGET)).toBe("n-a");
      db.close();
    });

    it("returns 'missing' when challenged but never proven (buried under 300 newer events)", () => {
      const db = mkDb(true);
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_challenged", payload: { challengeId: "c1" } });
      seedNoise(db, 300);
      expect(deriveOriented(db, TARGET)).toBe("missing");
      db.close();
    });

    it("returns 'verified' for a verified proof of the current challenge (buried)", () => {
      const db = mkDb(true);
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_challenged", payload: { challengeId: "c1" } });
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_proof_verified", payload: { challengeId: "c1" } });
      seedNoise(db, 300);
      expect(deriveOriented(db, TARGET)).toBe("verified");
      db.close();
    });

    it("returns 'rejected' for a rejected proof of the current challenge", () => {
      const db = mkDb(true);
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_challenged", payload: { challengeId: "c1" } });
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_proof_rejected", payload: { challengeId: "c1" } });
      seedNoise(db, 300);
      expect(deriveOriented(db, TARGET)).toBe("rejected");
      db.close();
    });

    it("a later verify overrides an earlier reject for the same challenge", () => {
      const db = mkDb(true);
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_challenged", payload: { challengeId: "c1" } });
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_proof_rejected", payload: { challengeId: "c1" } });
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_proof_verified", payload: { challengeId: "c1" } });
      expect(deriveOriented(db, TARGET)).toBe("verified");
      db.close();
    });

    it("the LATEST challenge governs — a proof for an older challenge does not count", () => {
      const db = mkDb(true);
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_challenged", payload: { challengeId: "c1" } });
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_proof_verified", payload: { challengeId: "c1" } });
      insertEvent(db, { rigId: RIG, nodeId: TARGET, type: "node.startup_challenged", payload: { challengeId: "c2" } });
      // c2 is the current challenge and has no proof → missing (the older c1 verify must not leak through).
      expect(deriveOriented(db, TARGET)).toBe("missing");
      db.close();
    });
  });
});
