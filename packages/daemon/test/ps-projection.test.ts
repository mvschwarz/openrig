import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { PsProjectionService, deriveRigLifecycleState } from "../src/domain/ps-projection.js";

describe("PsProjectionService", () => {
  let db: Database.Database;
  let ps: PsProjectionService;

  beforeEach(() => {
    db = createFullTestDb();
    ps = new PsProjectionService({ db });
  });

  afterEach(() => { db.close(); });

  function seedRig(name: string): string {
    const id = `rig-${name}`;
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(id, name);
    return id;
  }

  function seedNode(rigId: string, logicalId: string): string {
    const id = `node-${rigId}-${logicalId}`;
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run(id, rigId, logicalId);
    return id;
  }

  function seedSession(nodeId: string, status: string, createdAt?: string): string {
    const id = `sess-${nodeId}-${Date.now()}-${Math.random()}`;
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, nodeId, `tmux-${nodeId}`, status, createdAt ?? new Date().toISOString().replace("T", " ").slice(0, 19));
    return id;
  }

  function seedSnapshot(rigId: string, createdAt?: string): void {
    const id = `snap-${Date.now()}-${Math.random()}`;
    db.prepare("INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, rigId, "manual", "complete", "{}", createdAt ?? new Date().toISOString().replace("T", " ").slice(0, 19));
  }

  // T1: All nodes running -> status: running
  it("all nodes running -> status: running", () => {
    const rigId = seedRig("full-run");
    const n1 = seedNode(rigId, "dev");
    const n2 = seedNode(rigId, "qa");
    seedSession(n1, "running");
    seedSession(n2, "running");

    const entries = ps.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe("running");
    expect(entries[0]!.runningCount).toBe(2);
    expect(entries[0]!.nodeCount).toBe(2);
  });

  // T2: Some nodes exited -> status: partial
  it("some nodes exited -> status: partial", () => {
    const rigId = seedRig("partial");
    const n1 = seedNode(rigId, "dev");
    const n2 = seedNode(rigId, "qa");
    seedSession(n1, "running");
    seedSession(n2, "exited");

    const entries = ps.getEntries();
    expect(entries[0]!.status).toBe("partial");
    expect(entries[0]!.runningCount).toBe(1);
  });

  // T3: No running nodes -> status: stopped
  it("no running nodes -> status: stopped", () => {
    const rigId = seedRig("stopped");
    const n1 = seedNode(rigId, "dev");
    seedSession(n1, "exited");

    const entries = ps.getEntries();
    expect(entries[0]!.status).toBe("stopped");
    expect(entries[0]!.runningCount).toBe(0);
  });

  // T4: Uptime from earliest running session
  it("uptime computed from earliest running session", () => {
    const rigId = seedRig("uptime-test");
    const n1 = seedNode(rigId, "dev");
    seedSession(n1, "running", "2026-03-26 10:00:00");

    const entries = ps.getEntries();
    expect(entries[0]!.uptime).toBeTruthy();
    // Should be a duration string like "Xh Ym"
    expect(entries[0]!.uptime).toMatch(/\d+[smhd]/);
  });

  // T5: Latest snapshot age included
  it("latest snapshot age included", () => {
    const rigId = seedRig("snap-test");
    seedNode(rigId, "dev");
    seedSnapshot(rigId, "2026-03-26 10:00:00");

    const entries = ps.getEntries();
    expect(entries[0]!.latestSnapshot).toBeTruthy();
    expect(entries[0]!.latestSnapshot).toContain("ago");
  });

  // T6: Empty DB -> empty array
  it("empty DB returns empty array", () => {
    const entries = ps.getEntries();
    expect(entries).toEqual([]);
  });

  // T7: Node with multiple sessions, only newest counts
  it("multiple session rows per node — only newest counts", () => {
    const rigId = seedRig("multi-sess");
    const n1 = seedNode(rigId, "dev");
    seedSession(n1, "exited", "2026-03-26 09:00:00");
    seedSession(n1, "running", "2026-03-26 10:00:00"); // newest

    const entries = ps.getEntries();
    expect(entries[0]!.runningCount).toBe(1);
    expect(entries[0]!.status).toBe("running");
  });

  // T8: Multiple snapshots + sessions -> correct aggregation
  it("multiple snapshots + sessions aggregate correctly", () => {
    const rigId = seedRig("aggregate");
    const n1 = seedNode(rigId, "dev");
    const n2 = seedNode(rigId, "qa");
    seedSession(n1, "running");
    seedSession(n2, "running");
    seedSnapshot(rigId, "2026-03-26 08:00:00");
    seedSnapshot(rigId, "2026-03-26 09:00:00"); // latest

    const entries = ps.getEntries();
    expect(entries[0]!.nodeCount).toBe(2);
    expect(entries[0]!.runningCount).toBe(2);
    expect(entries[0]!.latestSnapshot).toBeTruthy();
  });

  // T9: Same-second session tiebreak by id
  it("same-second sessions resolved by id DESC", () => {
    const rigId = seedRig("tiebreak");
    const n1 = seedNode(rigId, "dev");
    // Insert with same timestamp, different IDs
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("sess-aaa", n1, "tmux-old", "exited", "2026-03-26 10:00:00");
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("sess-zzz", n1, "tmux-new", "running", "2026-03-26 10:00:00");

    const entries = ps.getEntries();
    // sess-zzz has later id -> it wins -> running
    expect(entries[0]!.runningCount).toBe(1);
    expect(entries[0]!.status).toBe("running");
  });

  // T10: createDaemon wires /api/ps route
  it("createDaemon wires /api/ps route", async () => {
    db.close();
    const { createDaemon } = await import("../src/startup.js");
    const { app, db: daemonDb } = await createDaemon({ dbPath: ":memory:" });
    try {
      const res = await app.request("/api/ps");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    } finally {
      daemonDb.close();
    }
  });

  // L2 rig-level lifecycleState
  describe("lifecycleState (L2)", () => {
    function seedSnapshotForRig(rigId: string, sessions: Array<{ nodeId: string; resumeToken: string | null }>): void {
      const data = {
        rig: { id: rigId, name: "rig-name", createdAt: "2026-04-28T00:00:00Z", updatedAt: "2026-04-28T00:00:00Z" },
        nodes: [],
        edges: [],
        sessions: sessions.map((s, i) => ({
          id: `sess-snap-${i}`,
          nodeId: s.nodeId,
          sessionName: `tmux-${s.nodeId}`,
          status: "detached",
          resumeType: s.resumeToken ? "claude" : null,
          resumeToken: s.resumeToken,
          restorePolicy: "resume_if_possible",
          lastSeenAt: null,
          createdAt: "2026-04-28T00:00:00Z",
          origin: "launched" as const,
          startupStatus: "ready" as const,
          startupCompletedAt: null,
        })),
        checkpoints: {},
      };
      db.prepare("INSERT INTO snapshots (id, rig_id, kind, status, data) VALUES (?, ?, ?, ?, ?)")
        .run(`snap-${rigId}`, rigId, "manual", "complete", JSON.stringify(data));
    }

    it("all nodes running -> lifecycleState=running", () => {
      const rigId = seedRig("all-run");
      const n1 = seedNode(rigId, "dev");
      const n2 = seedNode(rigId, "qa");
      seedSession(n1, "running");
      seedSession(n2, "running");

      const entries = ps.getEntries();
      expect(entries[0]!.lifecycleState).toBe("running");
    });

    it("all nodes detached + usable snapshot -> lifecycleState=recoverable", () => {
      const rigId = seedRig("all-recoverable");
      const n1 = seedNode(rigId, "dev");
      const n2 = seedNode(rigId, "qa");
      seedSession(n1, "detached");
      seedSession(n2, "detached");
      seedSnapshotForRig(rigId, [
        { nodeId: n1, resumeToken: "tok-1" },
        { nodeId: n2, resumeToken: "tok-2" },
      ]);

      const entries = ps.getEntries();
      expect(entries[0]!.lifecycleState).toBe("recoverable");
    });

    it("all nodes detached + no usable snapshot -> lifecycleState=stopped", () => {
      const rigId = seedRig("all-stopped");
      const n1 = seedNode(rigId, "dev");
      seedSession(n1, "detached");

      const entries = ps.getEntries();
      expect(entries[0]!.lifecycleState).toBe("stopped");
    });

    it("mixed running + detached -> lifecycleState=degraded", () => {
      const rigId = seedRig("mixed");
      const n1 = seedNode(rigId, "dev");
      const n2 = seedNode(rigId, "qa");
      seedSession(n1, "running");
      seedSession(n2, "detached");

      const entries = ps.getEntries();
      expect(entries[0]!.lifecycleState).toBe("degraded");
    });

    it("any node attention_required -> lifecycleState=attention_required (priority over running)", () => {
      const rigId = seedRig("att-priority");
      const n1 = seedNode(rigId, "dev");
      const n2 = seedNode(rigId, "qa");
      seedSession(n1, "running");
      seedSession(n2, "running");
      // Mark n2 as attention_required via failed restoreOutcome on a running session
      db.prepare(
        "INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)"
      ).run(rigId, n2, "restore.completed", JSON.stringify({
        result: { rigResult: "partially_restored", nodes: [{ nodeId: n2, status: "failed" }] },
        type: "restore.completed",
      }));

      const entries = ps.getEntries();
      expect(entries[0]!.lifecycleState).toBe("attention_required");
    });

    // L3-followup: rigName alias is always populated and equal to name.
    it("rigName alias is populated and equal to name on every entry (L3-followup)", () => {
      const rigA = seedRig("alpha");
      const rigB = seedRig("beta");
      seedNode(rigA, "dev");
      seedNode(rigB, "qa");

      const entries = ps.getEntries();
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) {
        expect(typeof e.rigName).toBe("string");
        expect(e.rigName.length).toBeGreaterThan(0);
        expect(e.rigName).toBe(e.name);
      }
    });

    it("lifecycleState is always populated even for empty rigs (L3-followup)", () => {
      seedRig("empty-rig");

      const entries = ps.getEntries();
      expect(entries[0]!.lifecycleState).toBeDefined();
      expect(entries[0]!.lifecycleState).not.toBeNull();
      expect(entries[0]!.lifecycleState).toBe("stopped");
    });

    // Pure unit-level coverage of the fold helper.
    it("deriveRigLifecycleState fold helper covers all branches", () => {
      expect(deriveRigLifecycleState([])).toBe("stopped");
      expect(deriveRigLifecycleState(["running", "running"])).toBe("running");
      expect(deriveRigLifecycleState(["detached", "detached"])).toBe("stopped");
      expect(deriveRigLifecycleState(["recoverable", "detached"])).toBe("recoverable");
      expect(deriveRigLifecycleState(["recoverable", "recoverable"])).toBe("recoverable");
      expect(deriveRigLifecycleState(["running", "detached"])).toBe("degraded");
      expect(deriveRigLifecycleState(["running", "recoverable"])).toBe("degraded");
      expect(deriveRigLifecycleState(["attention_required", "running"])).toBe("attention_required");
      expect(deriveRigLifecycleState(["attention_required", "detached"])).toBe("attention_required");
    });
  });
});
