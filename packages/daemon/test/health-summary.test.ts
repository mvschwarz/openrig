// Operator Surface Reconciliation v0 — health summary tests.
//
// Pins the daemon-side aggregation helpers consumed by /api/health-summary/*.
// Both `computeNodeHealthSummary` and `computeContextHealthSummary` are
// pure functions over already-shipped tables; tests build a small
// fixture DB and assert the rolled-up counts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import {
  computeContextHealthSummary,
  computeNodeHealthSummary,
} from "../src/domain/steering/health-summary.js";

describe("Operator Surface Reconciliation v0 — health summary", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
  });

  afterEach(() => db.close());

  describe("computeNodeHealthSummary", () => {
    it("returns zeros when no rigs exist", () => {
      const out = computeNodeHealthSummary({ db, rigRepo });
      expect(out).toEqual({ total: 0, bySessionStatus: {}, byLifecycle: {}, attentionRequired: 0 });
    });

    it("aggregates node sessionStatus across rigs", () => {
      const rigA = rigRepo.createRig("rig-a");
      const rigB = rigRepo.createRig("rig-b");
      rigRepo.addNode(rigA.id, "alpha", { role: "worker" });
      rigRepo.addNode(rigA.id, "beta", { role: "worker" });
      rigRepo.addNode(rigB.id, "gamma", { role: "worker" });
      const out = computeNodeHealthSummary({ db, rigRepo });
      expect(out.total).toBe(3);
      // Without sessions seeded, sessionStatus defaults to null/unknown.
      expect(Object.values(out.bySessionStatus).reduce((a, b) => a + b, 0)).toBe(3);
    });
  });

  describe("computeContextHealthSummary", () => {
    function insertContextUsage(nodeId: string, usedPercentage: number | null, sampledAt: string | null): void {
      // Insert a node row so the FK on context_usage(node_id) is satisfied.
      const rig = rigRepo.createRig(`rig-${nodeId}`);
      const node = rigRepo.addNode(rig.id, nodeId, { role: "worker" });
      db.prepare(
        `INSERT INTO context_usage (node_id, availability, used_percentage, sampled_at, updated_at)
         VALUES (?, 'known', ?, ?, ?)`
      ).run(node.id, usedPercentage, sampledAt, new Date().toISOString());
    }

    it("returns zeros when no context usage rows exist", () => {
      const out = computeContextHealthSummary({ db });
      expect(out.total).toBe(0);
      expect(out.critical).toBe(0);
      expect(out.warning).toBe(0);
      expect(out.stale).toBe(0);
    });

    it("classifies usedPercentage into urgency buckets (critical ≥80, warning ≥60, low otherwise)", () => {
      insertContextUsage("crit", 92, new Date().toISOString());
      insertContextUsage("warn", 70, new Date().toISOString());
      insertContextUsage("ok-1", 25, new Date().toISOString());
      insertContextUsage("ok-2", 0, new Date().toISOString());
      insertContextUsage("unknown", null, new Date().toISOString());
      const out = computeContextHealthSummary({ db });
      expect(out.total).toBe(5);
      expect(out.critical).toBe(1);
      expect(out.warning).toBe(1);
      expect(out.byUrgency["low"]).toBe(2);
      expect(out.byUrgency["unknown"]).toBe(1);
    });

    it("classifies samples older than 300s as stale", () => {
      insertContextUsage("fresh", 50, new Date().toISOString());
      insertContextUsage("stale", 50, new Date(Date.now() - 600_000).toISOString()); // 10 minutes ago
      insertContextUsage("none", 50, null);
      const out = computeContextHealthSummary({ db });
      expect(out.byFreshness["fresh"]).toBe(1);
      expect(out.byFreshness["stale"]).toBe(1);
      expect(out.byFreshness["none"]).toBe(1);
      expect(out.stale).toBe(1);
    });
  });
});
