import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { decodeTime } from "ulid";
import { createFullTestDb } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { PsProjectionService } from "../src/domain/ps-projection.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";

describe("ps session ordering", () => {
  let db: Database.Database;
  let registry: SessionRegistry;
  let clock = Date.UTC(2100, 0, 1);

  beforeEach(() => {
    db = createFullTestDb();
    clock += 60_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(clock);
    // Simulate the same wall clock at both production reads: ULID generation
    // and SQLite's DEFAULT datetime('now'). Session rows/IDs are never patched.
    db.function("datetime", (value: string) => {
      expect(value).toBe("now");
      return new Date().toISOString().replace("T", " ").slice(0, 19);
    });
    db.prepare("INSERT INTO rigs (id, name) VALUES ('r', 'ordering')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n', 'r', 'dev')").run();
    registry = new SessionRegistry(db);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  describe.each([
    ["forward", 2_000], ["same millisecond", 0], ["rollback", -2_000],
  ] as const)("after a %s clock", (_name, delta) => {
    it.each(["running", "exited"])("uses the current %s registration", (status) => {
      const old = registry.registerClaimedSession("n", "dev@ordering");
      registry.updateStatus(old.id, status === "running" ? "exited" : "running");
      vi.setSystemTime(clock + delta);
      const current = registry.registerClaimedSession("n", "dev@ordering");
      registry.updateStatus(current.id, status);
      expect(current.id > old.id).toBe(true);
      expect(decodeTime(current.id)).toBe(clock + Math.max(delta, 0));
      if (delta < 0) expect(current.createdAt < old.createdAt).toBe(true);
      vi.setSystemTime(clock + 5_000);

      expect(getNodeInventory(db, "r")[0]!.sessionStatus).toBe(status);
      expect(new PsProjectionService({ db }).getEntries()[0]).toMatchObject({
        runningCount: status === "running" ? 1 : 0,
        status: status === "running" ? "running" : "stopped",
        lifecycleState: status === "running" ? "running" : "stopped",
        uptime: status === "running" ? `${(5_000 - delta) / 1_000}s` : null,
      });
    });
  });

  it("does not subtract a missing replacement from another node after clock rollback", () => {
    const old = registry.registerClaimedSession("n", "dev@ordering");
    registry.updateStatus(old.id, "exited");
    vi.setSystemTime(clock - 2_000);
    registry.registerClaimedSession("n", "dev@ordering");
    registry.updateBinding("n", { tmuxSession: "dev@ordering", tmuxPane: "%1" });
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('peer', 'r', 'qa')").run();
    registry.registerClaimedSession("peer", "qa@ordering");
    vi.setSystemTime(clock + 5_000);
    new SeatIdentityStore(db).upsert({
      nodeId: "n", verdict: "pane_missing", reason: "session_missing",
      evidenceSource: "tmux_session", sessionName: "dev@ordering",
      evidence: { registeredPane: "%1", observedPid: null, observedCommand: null, matchedLayer: null },
      observedAt: new Date().toISOString(),
    });

    expect(getNodeInventory(db, "r").find((node) => node.nodeId === "n")!.sessionStatus).toBe("detached");
    expect(new PsProjectionService({ db }).getEntries()[0]).toMatchObject({
      runningCount: 1, nodeCount: 2, status: "partial", lifecycleState: "degraded",
    });
  });

  it.each([false, true])("excludes a confirmed-missing replacement from uptime (healthy sibling: %s)", (withSibling) => {
    const old = registry.registerClaimedSession("n", "dev@ordering");
    registry.updateStatus(old.id, "exited");
    vi.setSystemTime(clock - 2_000);
    registry.registerClaimedSession("n", "dev@ordering");
    registry.updateBinding("n", { tmuxSession: "dev@ordering", tmuxPane: "%1" });
    if (withSibling) {
      vi.setSystemTime(clock + 4_000);
      db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('peer', 'r', 'qa')").run();
      registry.registerClaimedSession("peer", "qa@ordering");
    }
    vi.setSystemTime(clock + 10_000);
    new SeatIdentityStore(db).upsert({
      nodeId: "n", verdict: "pane_missing", reason: "session_missing",
      evidenceSource: "tmux_session", sessionName: "dev@ordering",
      evidence: { registeredPane: "%1", observedPid: null, observedCommand: null, matchedLayer: null },
      observedAt: new Date().toISOString(),
    });

    const stored = db.prepare("SELECT * FROM sessions ORDER BY id").all();
    expect(new PsProjectionService({ db }).getEntries()[0]).toMatchObject({
      runningCount: withSibling ? 1 : 0,
      status: withSibling ? "partial" : "stopped",
      uptime: withSibling ? "6s" : null,
    });
    expect(db.prepare("SELECT * FROM sessions ORDER BY id").all()).toEqual(stored);
  });
});
