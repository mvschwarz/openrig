import { rosterReadyNoticeId } from "../src/domain/roster-ready-notice.js";
import { OPENRIG_SENDER } from "../src/lib/pane-envelope.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// #3636 — hoisted importOriginal passthrough: every export stays the real
// implementation; only the two inventory builders are wrapped, so the scoping
// tests can see which rigs a projection folds. Behavior is unchanged.
vi.mock("../src/domain/node-inventory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/domain/node-inventory.js")>();
  return {
    ...actual,
    getNodeInventoryForAllRigs: vi.fn(actual.getNodeInventoryForAllRigs),
    getNodeInventoryForRigs: vi.fn(actual.getNodeInventoryForRigs),
  };
});
import type Database from "better-sqlite3";
import { monotonicFactory } from "ulid";
import { createFullTestDb } from "./helpers/test-app.js";
import { PsProjectionService, deriveRigLifecycleState, seatNeedsAttention, arbitratedNeedsInputSignal } from "../src/domain/ps-projection.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { attachTerminalActivityAndWork, getNodeInventory, getNodeInventoryForAllRigs, getNodeInventoryForRigs } from "../src/domain/node-inventory.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { AgentActivity, NodeInventoryEntry } from "../src/domain/types.js";
import type { EvidenceRungId } from "../src/domain/activity-taxonomy.js";

const sessionId = monotonicFactory();

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
    const id = sessionId();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, nodeId, `tmux-${nodeId}`, status, createdAt ?? new Date().toISOString().replace("T", " ").slice(0, 19));
    return id;
  }

  function seedSnapshot(rigId: string, createdAt?: string): void {
    const id = `snap-${Date.now()}-${Math.random()}`;
    db.prepare("INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, rigId, "manual", "complete", "{}", createdAt ?? new Date().toISOString().replace("T", " ").slice(0, 19));
  }

  it("keeps an unlaunched held seat visible without degrading an otherwise running rig, until it owes work", () => {
    const rigId = seedRig("planned-hold");
    seedSession(seedNode(rigId, "worker"), "running");
    const held = seedNode(rigId, "optional.worker");
    db.prepare("INSERT INTO events (rig_id, node_id, type, payload, created_at) VALUES (?, ?, 'node.held', ?, datetime('now'))")
      .run(rigId, held, JSON.stringify({ reason: "on demand" }));

    const row = () => attachTerminalActivityAndWork(getNodeInventory(db, rigId), { db }).find((n) => n.nodeId === held)!;
    expect(row()).toMatchObject({ heldReason: "on demand", needsAttention: false, hasAssignedWork: false });
    expect(ps.getEntries()[0]).toMatchObject({ lifecycleState: "running", status: "partial", runningCount: 1, attentionCount: 0 });

    const destination = "optional-worker@planned-hold";
    db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, body)
      VALUES ('q-planned', datetime('now'), datetime('now'), 'operator@test', ?, 'pending', 'routine', 'routine', 'work')`).run(destination);
    expect(row()).toMatchObject({ needsAttention: true, hasAssignedWork: true });
    expect(ps.getEntries()[0]).toMatchObject({ lifecycleState: "degraded", runningCount: 1, attentionCount: 1 });
  });

  it("keeps attention on a held seat whose earlier restore already ended failed", () => {
    const rigId = seedRig("held-after-failure");
    seedSession(seedNode(rigId, "worker"), "running");
    const held = seedNode(rigId, "optional.worker");
    // An earlier restore named this seat and ended `failed`; it recorded no startup error, so only
    // the restore outcome carries the fact. A later subset launch leaves the seat out and writes
    // `node.held` for it without recording any result.
    db.prepare("INSERT INTO events (rig_id, node_id, type, payload, created_at) VALUES (?, ?, 'restore.completed', ?, datetime('now'))")
      .run(rigId, held, JSON.stringify({ result: { nodes: [{ nodeId: held, status: "failed" }] } }));
    db.prepare("INSERT INTO events (rig_id, node_id, type, payload, created_at) VALUES (?, ?, 'node.held', ?, datetime('now'))")
      .run(rigId, held, JSON.stringify({ reason: "on demand" }));

    const row = () => attachTerminalActivityAndWork(getNodeInventory(db, rigId), { db }).find((n) => n.nodeId === held)!;
    expect(row()).toMatchObject({ heldReason: "on demand", restoreOutcome: "failed", needsAttention: true, hasAssignedWork: false });
    expect(ps.getEntries()[0]).toMatchObject({ lifecycleState: "degraded", runningCount: 1, attentionCount: 1 });
  });

  it("does not count all held seats as running or hide an unexpected detached seat", () => {
    const rigId = seedRig("held-only");
    const held = seedNode(rigId, "optional.worker");
    db.prepare("INSERT INTO events (rig_id, node_id, type, payload, created_at) VALUES (?, ?, 'node.held', ?, datetime('now'))")
      .run(rigId, held, JSON.stringify({ reason: "on demand" }));
    expect(ps.getEntries()[0]).toMatchObject({ lifecycleState: "stopped", runningCount: 0, attentionCount: 0 });
    seedSession(seedNode(rigId, "running"), "running");
    seedNode(rigId, "unexpected");
    expect(ps.getEntries()[0]).toMatchObject({ lifecycleState: "degraded", runningCount: 1 });
  });

  it("retains attention for held seats with startup errors or an unresolvable work destination", () => {
    const rigId = seedRig("held-errors");
    const failed = seedNode(rigId, "optional.failed");
    const unresolved = seedNode(rigId, "unresolved");
    for (const node of [failed, unresolved]) {
      db.prepare("INSERT INTO events (rig_id, node_id, type, payload, created_at) VALUES (?, ?, 'node.held', ?, datetime('now'))")
        .run(rigId, node, JSON.stringify({ reason: "on demand" }));
    }
    db.prepare("INSERT INTO events (rig_id, node_id, type, payload, created_at) VALUES (?, ?, 'node.startup_failed', ?, datetime('now'))")
      .run(rigId, failed, JSON.stringify({ error: "launch failed" }));
    const nodes = attachTerminalActivityAndWork(getNodeInventory(db, rigId), { db });
    expect(nodes.map((node) => node.needsAttention)).toEqual([true, true]);
    expect(ps.getEntries()[0]!.attentionCount).toBe(2);
  });

  // A pane restore left as a bare shell (no harness started) carries its own marker and isn't counted running. A seat
  // that needs attention for another reason (an identity question here) keeps the existing running count, and so does a
  // later launch on a once-bare seat: the marker belongs to the session that recorded it.
  it("a seat restore left as a bare shell isn't counted running; other attention still is", () => {
    const rigId = seedRig("shell-only");
    const shell = seedNode(rigId, "shell");
    const asked = seedNode(rigId, "asked");
    const relaunched = seedNode(rigId, "relaunched");
    const bus = new EventBus(db);
    for (const [nodeId, stage] of [[shell, "harness_not_started"], [asked, "identity_verification"], [relaunched, "harness_not_started"]] as const) {
      const id = seedSession(nodeId, "running");
      db.prepare("UPDATE sessions SET startup_status = 'attention_required' WHERE id = ?").run(id);
      bus.emit({ type: "node.startup_failed", rigId, nodeId, error: `fixture ${stage}`, sessionId: id, stage });
    }
    // The relaunch's own session needs attention (an identity check that records no startup failure).
    db.prepare("UPDATE sessions SET status = 'exited' WHERE node_id = ?").run(relaunched);
    const next = seedSession(relaunched, "running");
    db.prepare("UPDATE sessions SET startup_status = 'attention_required' WHERE id = ?").run(next);

    const entries = ps.getEntries();
    expect(entries[0]!.nodeCount).toBe(3);
    expect(entries[0]!.runningCount).toBe(2);
    const inventory = getNodeInventory(db, rigId);
    expect(inventory.find((node) => node.logicalId === "shell")).toMatchObject({ startupStatus: "attention_required", latestErrorStage: "harness_not_started" });
    expect(inventory.find((node) => node.logicalId === "asked")).toMatchObject({ startupStatus: "attention_required", latestErrorStage: "identity_verification" });
    expect(inventory.find((node) => node.logicalId === "relaunched")).toMatchObject({ sessionStatus: "running", startupStatus: "attention_required", latestErrorStage: null });
  });

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
    it.each([true, false])("does not fold a retained standby pane as degraded (running peer: %s)", livePeer => {
      const rigId = seedRig("standby");
      const nodeId = seedNode(rigId, "qa");
      const sessionId = seedSession(nodeId, "running");
      const sessionName = `tmux-${nodeId}`;
      const registry = new SessionRegistry(db);
      registry.updateBinding(nodeId, { attachmentType: "tmux", tmuxSession: sessionName, tmuxPane: "%1" });
      registry.markIntentionallyStopped(sessionId);
      new EventBus(db).emit({ type: "session.stopped", rigId, nodeId, sessionId, sessionName,
        operator: "daemon:seat-reaper", reason: "idle_reap", standbyPane: "$1|42|100|%1" });
      if (livePeer) seedSession(seedNode(rigId, "dev"), "running");

      expect(getNodeInventory(db, rigId).find(entry => entry.nodeId === nodeId)).toMatchObject({ standbyStopped: true });
      expect(ps.getEntries()[0]).toMatchObject({ lifecycleState: livePeer ? "running" : "stopped",
        status: livePeer ? "partial" : "stopped", runningCount: Number(livePeer) });
    });

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

    it("keeps intentionally stopped seats recoverable without degrading the active rig", () => {
      const rigId = seedRig("intentional-recoverable");
      const stopped = seedNode(rigId, "qa");
      const live = seedNode(rigId, "dev");
      const stoppedSession = seedSession(stopped, "running");
      const liveSession = seedSession(live, "running");
      const registry = new SessionRegistry(db);
      seedSnapshotForRig(rigId, [{ nodeId: stopped, resumeToken: "qa-resume-token" }]);
      registry.markIntentionallyStopped(stoppedSession);

      expect(getNodeInventory(db, rigId).find((entry) => entry.nodeId === stopped)).toMatchObject({
        lifecycleState: "recoverable", intentionallyStopped: true, sessionStatus: "exited",
      });
      expect(ps.getEntries()[0]).toMatchObject({
        lifecycleState: "running", status: "partial", nodeCount: 2, runningCount: 1,
      });

      registry.markIntentionallyStopped(liveSession);
      expect(ps.getEntries()[0]).toMatchObject({ lifecycleState: "stopped", runningCount: 0 });
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

    // OPR.0.3.4.6 — cross-surface regression guard: projection never collapses
    // attention_required to failed at the rig level.
    it("OPR.0.3.4.6 guard: attention_required node NEVER maps to rig-level 'failed' (always 'attention_required')", () => {
      expect(deriveRigLifecycleState(["attention_required"])).toBe("attention_required");
      expect(deriveRigLifecycleState(["attention_required"])).not.toBe("failed");
      expect(deriveRigLifecycleState(["attention_required", "running", "detached"])).toBe("attention_required");
      expect(deriveRigLifecycleState(["attention_required", "running", "detached"])).not.toBe("failed");
    });
  });

  // Slice 15 — `terminal-active` count + `has-work` count are PARALLEL
  // primitives on PsEntry; `runningCount` (process-alive) stays unchanged.
  // The tests below pin the non-inference contract (HG-3 + HG-4): the
  // two new counts must be observable independently — a seat in one
  // state should NOT pull the other count up with it.
  describe("slice 15 — activeCount + hasWorkCount (parallel to runningCount)", () => {
    function makeSeatActivityFor(activeByPaneId: Record<string, boolean>) {
      return {
        getSeatActivity: (paneId: string) => {
          if (paneId in activeByPaneId) {
            return {
              paneId,
              isActiveWithinWindow: activeByPaneId[paneId]!,
              silenceWindowSeconds: 3,
              lastObservedAt: "2026-05-16T00:00:00.000Z",
              lastActivityAt: "2026-05-15T23:59:40.000Z",
            };
          }
          return null;
        },
      };
    }

    function seedQitem(destinationSession: string, state: string): void {
      const id = `qitem-${Date.now()}-${Math.random()}`;
      const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
      db.prepare(`
        INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, body)
        VALUES (?, ?, ?, ?, ?, ?, 'routine', 'routine', ?)
      `).run(id, ts, ts, "operator@test", destinationSession, state, "test-body");
    }

    function seedPendingQitem(destinationSession: string): void {
      seedQitem(destinationSession, "pending");
    }

    it("runningCount stays process-alive semantics; activeCount + hasWorkCount default to 0 when no signals wired", () => {
      const rigId = seedRig("baseline");
      const n1 = seedNode(rigId, "dev");
      seedSession(n1, "running");

      const entries = ps.getEntries();
      expect(entries[0]!.runningCount).toBe(1);
      expect(entries[0]!.activeCount).toBe(0);
      expect(entries[0]!.hasWorkCount).toBe(0);
    });

    it("HG-3 direction A — seat producing output with NOTHING queued: terminalActive=true, hasAssignedWork=false ⇒ activeCount=1, hasWorkCount=0", () => {
      const rigId = seedRig("active-no-work");
      const n1 = seedNode(rigId, "dev");
      seedSession(n1, "running");
      const paneId = `tmux-${n1}`;
      const seatActivity = makeSeatActivityFor({ [paneId]: true });
      const psWithActivity = new PsProjectionService({ db, seatActivity: seatActivity as never });

      const entries = psWithActivity.getEntries();
      expect(entries[0]!.activeCount).toBe(1);
      expect(entries[0]!.hasWorkCount).toBe(0);
      // process-alive count unchanged
      expect(entries[0]!.runningCount).toBe(1);
    });

    it.each(["pending", "in-progress", "blocked"])("keeps roster-ready %s information out of rig ps work totals", state => {
      const rigId = seedRig("information-only");
      const nodeId = seedNode(rigId, "dev");
      seedSession(nodeId, "running");
      const destination = `tmux-${nodeId}`;
      db.prepare(`INSERT INTO queue_items (qitem_id, source_session, destination_session, body, state, ts_created, ts_updated)
        VALUES (?, ?, ?, 'Information only', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
        .run(rosterReadyNoticeId(rigId, destination), OPENRIG_SENDER, destination, state);
      expect(ps.getEntries()[0]).toMatchObject({ hasWorkCount: 0, runningCount: 1 });
      seedPendingQitem(destination);
      expect(ps.getEntries()[0]).toMatchObject({ hasWorkCount: 1, runningCount: 1 });
    });

    it("HG-3 direction B — seat SILENT with queued work: terminalActive=false, hasAssignedWork=true ⇒ activeCount=0, hasWorkCount=1", () => {
      const rigId = seedRig("idle-with-work");
      const n1 = seedNode(rigId, "dev");
      seedSession(n1, "running");
      const paneId = `tmux-${n1}`;
      seedPendingQitem(paneId);
      const seatActivity = makeSeatActivityFor({ [paneId]: false });
      const psWithActivity = new PsProjectionService({ db, seatActivity: seatActivity as never });

      const entries = psWithActivity.getEntries();
      expect(entries[0]!.activeCount).toBe(0);
      expect(entries[0]!.hasWorkCount).toBe(1);
      expect(entries[0]!.runningCount).toBe(1);
    });

    it("HG-4 non-inference — fake activity state does NOT change hasWorkCount; fake queue state does NOT change activeCount", () => {
      const rigId = seedRig("non-inference");
      const n1 = seedNode(rigId, "dev");
      seedSession(n1, "running");
      const paneId = `tmux-${n1}`;

      // Start: silent seat, no queued work. Both counts 0.
      const seatActivitySilent = makeSeatActivityFor({ [paneId]: false });
      let entries = new PsProjectionService({ db, seatActivity: seatActivitySilent as never }).getEntries();
      expect(entries[0]!.activeCount).toBe(0);
      expect(entries[0]!.hasWorkCount).toBe(0);

      // Flip ONLY queue state (add pending qitem). activeCount must NOT move.
      seedPendingQitem(paneId);
      entries = new PsProjectionService({ db, seatActivity: seatActivitySilent as never }).getEntries();
      expect(entries[0]!.activeCount).toBe(0); // unchanged — proves no queue→active inference
      expect(entries[0]!.hasWorkCount).toBe(1);

      // Flip ONLY activity state (active observation), keep qitem. hasWorkCount must hold steady.
      const seatActivityActive = makeSeatActivityFor({ [paneId]: true });
      entries = new PsProjectionService({ db, seatActivity: seatActivityActive as never }).getEntries();
      expect(entries[0]!.activeCount).toBe(1);
      expect(entries[0]!.hasWorkCount).toBe(1); // unchanged — proves no active→hasWork inference
    });

    it("running-but-no-observation reads as inactive (activeCount=0) — null SeatActivity is distinct from active", () => {
      const rigId = seedRig("no-obs");
      const n1 = seedNode(rigId, "dev");
      seedSession(n1, "running");
      // SeatActivity returns null for every paneId — no observations yet.
      const seatActivity = { getSeatActivity: () => null };
      const psWithActivity = new PsProjectionService({ db, seatActivity: seatActivity as never });

      const entries = psWithActivity.getEntries();
      expect(entries[0]!.runningCount).toBe(1);
      expect(entries[0]!.activeCount).toBe(0); // no signal ≠ active
    });

    it("hasWorkCount counts DISTINCT nodes; multiple qitems on one seat counts the seat once", () => {
      const rigId = seedRig("multi-qitem");
      const n1 = seedNode(rigId, "dev");
      seedSession(n1, "running");
      const paneId = `tmux-${n1}`;
      seedPendingQitem(paneId);
      seedPendingQitem(paneId);
      seedPendingQitem(paneId);

      const entries = ps.getEntries();
      expect(entries[0]!.hasWorkCount).toBe(1);
    });

    it("active qitems count toward hasWorkCount while terminal qitems do not", () => {
      const rigId = seedRig("only-pending");
      const n1 = seedNode(rigId, "dev");
      seedSession(n1, "running");
      const paneId = `tmux-${n1}`;
      for (const state of ["pending", "in-progress", "blocked", "done", "canceled", "handed-off"]) {
        seedQitem(paneId, state);
      }

      const entries = ps.getEntries();
      expect(entries[0]!.hasWorkCount).toBe(1); // one seat, regardless of its three active rows
    });

    it.each(["in-progress", "blocked"])("slice 17 — a seat with only %s work counts as assigned", (state) => {
      const rigId = seedRig(`assigned-${state}`);
      const n1 = seedNode(rigId, "dev");
      seedSession(n1, "running");
      seedQitem(`tmux-${n1}`, state);

      expect(ps.getEntries()[0]!.hasWorkCount).toBe(1);
    });
  });

  // OPR.0.4.4.21 — the rig-rollup attention predicate + fold (FR-1).
  describe("OPR.0.4.4.21 — attentionCount (one predicate, one count per seat)", () => {
    const baseEntry = (over: Partial<NodeInventoryEntry> = {}): NodeInventoryEntry => ({
      rigId: "r", rigName: "r", nodeId: "n", logicalId: "dev",
      canonicalSessionName: "dev@r",
      sessionStatus: "running",
      startupStatus: "ready",
      lifecycleState: "running",
      latestError: null,
      heldReason: null,
      ...over,
    } as NodeInventoryEntry);

    const idleActivity = (state: AgentActivity["state"]): AgentActivity => ({
      state, reason: "test", evidenceSource: "runtime_hook",
      sampledAt: new Date().toISOString(), fallback: false, stale: false,
    } as AgentActivity);

    it("counts each signal alone: lifecycle attention", () => {
      expect(seatNeedsAttention(baseEntry({ lifecycleState: "attention_required" }), null)).toBe(true);
    });
    it("counts startup attention_required DIRECTLY from startupStatus", () => {
      expect(seatNeedsAttention(baseEntry({ startupStatus: "attention_required" }), null)).toBe(true);
    });
    it("counts startup failed even when latestError is NULL (never a prerequisite)", () => {
      expect(seatNeedsAttention(baseEntry({ startupStatus: "failed", latestError: null }), null)).toBe(true);
    });
    it("counts a live needs_input hook", () => {
      expect(seatNeedsAttention(baseEntry(), idleActivity("needs_input"))).toBe(true);
    });
    it("counts a held seat", () => {
      expect(seatNeedsAttention(baseEntry({ heldReason: "held: staged launch" }), null)).toBe(true);
    });
    it("counts a recorded startup error as an ADDITIONAL signal", () => {
      expect(seatNeedsAttention(baseEntry({ latestError: "boom" }), null)).toBe(true);
    });
    it("healthy seat with running/idle/unknown activity does NOT count (unknown is not attention)", () => {
      expect(seatNeedsAttention(baseEntry(), null)).toBe(false);
      expect(seatNeedsAttention(baseEntry(), idleActivity("running"))).toBe(false);
      expect(seatNeedsAttention(baseEntry(), idleActivity("idle"))).toBe(false);
      expect(seatNeedsAttention(baseEntry(), idleActivity("unknown"))).toBe(false);
    });
    it("#81: counts an ARBITRATED needs_input (pane chrome) even with no hook store", () => {
      expect(seatNeedsAttention(baseEntry(), null, true)).toBe(true);
    });
    it("#81: an arbitrated clear answer SUPERSEDES a stale needs_input hook (row and total agree)", () => {
      expect(seatNeedsAttention(baseEntry(), idleActivity("needs_input"), false)).toBe(false);
    });
    it("#81: no arbitrated answer falls back to the hook signal (honest degrade)", () => {
      expect(seatNeedsAttention(baseEntry(), idleActivity("needs_input"), null)).toBe(true);
    });

    // #3571: a current Claude auth or billing StopFailure counts, as attention and never as a question.
    const stopFailure = (error: string, reason: string, over: Partial<AgentActivity> = {}): AgentActivity => ({
      ...idleActivity("unknown"), reason, rawEvent: "StopFailure", rawSubtype: error, evidence: error, runtime: "claude-code", ...over,
    } as AgentActivity);
    const claudeSeat = baseEntry({ runtime: "claude-code" } as Partial<NodeInventoryEntry>);
    it("#3571: counts a current Claude auth or billing failure, which an arbitrated clear doesn't cancel", () => {
      expect(seatNeedsAttention(claudeSeat, stopFailure("authentication_failed", "provider_auth_error"), null)).toBe(true);
      expect(seatNeedsAttention(claudeSeat, stopFailure("billing_error", "provider_billing_error"), false)).toBe(true);
    });
    it.each([
      { name: "a generic provider error", activity: stopFailure("server_error", "provider_error") },
      { name: "an unlisted value", activity: stopFailure("auth_expired", "provider_error") },
      { name: "a stale report", activity: stopFailure("authentication_failed", "stale_runtime_hook", { stale: true }) },
      { name: "a generation-mismatched report", activity: stopFailure("billing_error", "generation_mismatch", { stale: true }) },
      { name: "another runtime's report", activity: stopFailure("authentication_failed", "provider_auth_error", { runtime: "codex" }) },
      { name: "a typed reason on another event", activity: stopFailure("authentication_failed", "provider_auth_error", { rawEvent: "Notification" }) },
      { name: "a reason the value doesn't map to", activity: stopFailure("server_error", "provider_auth_error") },
      { name: "the other typed reason", activity: stopFailure("authentication_failed", "provider_billing_error") },
      { name: "a report marked stale", activity: stopFailure("authentication_failed", "provider_auth_error", { stale: true }) },
      { name: "a fallback reading", activity: stopFailure("authentication_failed", "provider_auth_error", { fallback: true }) },
    ])("#3571: doesn't count $name", ({ activity }) => {
      expect(seatNeedsAttention(claudeSeat, activity, null)).toBe(false);
    });
    it("#3571: doesn't count a Claude failure on a seat of another runtime", () => {
      const codexSeat = baseEntry({ runtime: "codex" } as Partial<NodeInventoryEntry>);
      expect(seatNeedsAttention(codexSeat, stopFailure("authentication_failed", "provider_auth_error"), null)).toBe(false);
    });

    it("#180 review: arbitratedNeedsInputSignal is tri-state over observed needs-input evidence", () => {
      const zero = { count: 0, reason: null };
      const observed = (rung: EvidenceRungId) => ({ rung, observedAt: new Date().toISOString() });
      expect(arbitratedNeedsInputSignal(null)).toBeNull();
      expect(arbitratedNeedsInputSignal({ needsInput: { count: 1, reason: "prompt" }, needsInputEvidence: observed("lifecycle-hooks") })).toBe(true);
      // count: 0 that no needs-input evidence supplied is "no trusted evidence", whatever rungs are declared
      expect(arbitratedNeedsInputSignal({ needsInput: zero, needsInputEvidence: null })).toBeNull();
      expect(arbitratedNeedsInputSignal({ needsInput: zero, needsInputEvidence: observed("window-sampling") })).toBeNull();
      // ...and an observed clear from a needs-input rung is a real no
      expect(arbitratedNeedsInputSignal({ needsInput: zero, needsInputEvidence: observed("self-report") })).toBe(false);
      expect(arbitratedNeedsInputSignal({ needsInput: zero, needsInputEvidence: observed("needs-input-chrome") })).toBe(false);
      expect(arbitratedNeedsInputSignal({ needsInput: zero, needsInputEvidence: observed("lifecycle-hooks") })).toBe(false);
    });

    it("getEntries: multi-signal seat counts ONCE; healthy peers count zero", () => {
      const rigId = seedRig("attn-once");
      const bad = seedNode(rigId, "bad");
      const ok = seedNode(rigId, "ok");
      // bad: failed startup AND a startup error AND held (three signals, one seat)
      db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
        .run("s-bad", bad, "bad@attn-once", "exited", "failed");
      db.prepare("INSERT INTO events (rig_id, node_id, type, payload, created_at) VALUES (?, ?, 'node.startup_failed', ?, datetime('now'))")
        .run(rigId, bad, JSON.stringify({ error: "launch exploded" }));
      db.prepare("INSERT INTO events (rig_id, node_id, type, payload, created_at) VALUES (?, ?, 'node.held', ?, datetime('now'))")
        .run(rigId, bad, JSON.stringify({ reason: "held" }));
      db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
        .run("s-ok", ok, "ok@attn-once", "running", "ready");

      const entries = ps.getEntries();
      expect(entries.find((e) => e.rigId === rigId)!.attentionCount).toBe(1);
    });

    it("getEntries: fresh needs_input hook counts via the store; stale hook degrades to unknown and does NOT", () => {
      const rigId = seedRig("attn-hook");
      const n = seedNode(rigId, "dev");
      db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
        .run("s-hook", n, "dev@attn-hook", "running", "ready");
      const eventBus = new EventBus(db);
      const store = new AgentActivityStore({ db, eventBus });
      const emit = (eventAt: string) => eventBus.emit({
        type: "agent.activity", rigId, nodeId: n, sessionName: "dev@attn-hook", runtime: "claude-code",
        activity: { state: "needs_input", reason: "permission_prompt", evidenceSource: "runtime_hook",
          sampledAt: eventAt, eventAt, evidence: "permission_prompt", fallback: false, stale: false },
      } as never);

      emit(new Date().toISOString()); // fresh
      const withStore = new PsProjectionService({ db, agentActivity: store });
      expect(withStore.getEntries().find((e) => e.rigId === rigId)!.attentionCount).toBe(1);

      emit(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()); // stale (latest row now old)
      expect(withStore.getEntries().find((e) => e.rigId === rigId)!.attentionCount).toBe(0);
    });

    it("#81: getEntries reads the ARBITRATED needs_input the per-seat row shows (pane chrome, hook-silent seat)", () => {
      const rigId = seedRig("attn-arbitrated");
      const n = seedNode(rigId, "dev");
      db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
        .run("s-arb", n, "dev@attn-arbitrated", "running", "ready");
      // The row-facing oracle: a seat frozen at a permission prompt with no hook
      // traffic — exactly the reported case where the row said needs-input x1
      // and the rig total said 0.
      const seatActivity = {
        getSeatActivity: () => null,
        getSeatStateBySession: (sessionName: string) => sessionName === "dev@attn-arbitrated"
          ? {
              seatNodeId: n, activity: "idle-at-prompt",
              needsInput: { count: 1, reason: "selection_prompt" },
              decidedBy: "needs-input-chrome", seq: 1,
              changedAt: new Date().toISOString(), rungs: [], lastSwap: null,
            }
          : null,
      };
      const entries = new PsProjectionService({ db, seatActivity: seatActivity as never }).getEntries();
      expect(entries.find((e) => e.rigId === rigId)!.attentionCount).toBe(1);
    });

    it("#81: getEntries takes the arbitrated answer over a stale needs_input hook", () => {
      const rigId = seedRig("attn-stale-hook");
      const n = seedNode(rigId, "dev");
      db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
        .run("s-stale", n, "dev@attn-stale-hook", "running", "ready");
      const eventBus = new EventBus(db);
      const store = new AgentActivityStore({ db, eventBus });
      eventBus.emit({
        type: "agent.activity", rigId, nodeId: n, sessionName: "dev@attn-stale-hook", runtime: "claude-code",
        activity: { state: "needs_input", reason: "permission_prompt", evidenceSource: "runtime_hook",
          sampledAt: new Date().toISOString(), eventAt: new Date().toISOString(), evidence: "permission_prompt", fallback: false, stale: false },
      } as never);
      // The hook store still carries needs_input, but the seat's arbitrated state
      // (what its row renders) is already clear from AUTHORITATIVE needs-input
      // evidence (a later hook turn boundary) — the totals must agree.
      const seatActivity = {
        getSeatActivity: () => null,
        getSeatStateBySession: () => ({
          seatNodeId: n, activity: "working",
          needsInput: { count: 0, reason: null },
          needsInputEvidence: { rung: "lifecycle-hooks", observedAt: new Date().toISOString() },
          decidedBy: "lifecycle-hooks", seq: 2,
          changedAt: new Date().toISOString(),
          rungs: [{ rung: "lifecycle-hooks", sourceId: "claude-code:hooks", trust: "authoritative", lastEvidenceAt: new Date().toISOString() }],
          lastSwap: null,
        }),
      };
      const entries = new PsProjectionService({ db, agentActivity: store, seatActivity: seatActivity as never }).getEntries();
      expect(entries.find((e) => e.rigId === rigId)!.attentionCount).toBe(0);
    });

    it("#180 review: a Codex seat with hooks at trial falls back to the hook store — a fresh PermissionRequest counts 1", () => {
      const rigId = seedRig("attn-codex-trial");
      const n = seedNode(rigId, "dev");
      db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
        .run("s-codex", n, "dev@attn-codex-trial", "running", "ready");
      const eventBus = new EventBus(db);
      const store = new AgentActivityStore({ db, eventBus });
      eventBus.emit({
        type: "agent.activity", rigId, nodeId: n, sessionName: "dev@attn-codex-trial", runtime: "codex",
        activity: { state: "needs_input", reason: "permission_prompt", evidenceSource: "runtime_hook",
          sampledAt: new Date().toISOString(), eventAt: new Date().toISOString(), evidence: "permission_prompt", fallback: false, stale: false },
      } as never);
      // Codex lifecycle hooks enter at `trial` (AM-2), so the oracle's count: 0 is
      // "no trusted evidence", not a real "no" — the live PermissionRequest must
      // still count, exactly as it did before the arbitrated signal was preferred.
      const seatActivity = {
        getSeatActivity: () => null,
        getSeatStateBySession: () => ({
          seatNodeId: n, activity: "working",
          needsInput: { count: 0, reason: null },
          decidedBy: "window-sampling", seq: 3,
          changedAt: new Date().toISOString(),
          rungs: [
            { rung: "lifecycle-hooks", sourceId: "codex:hooks", trust: "trial", lastEvidenceAt: new Date().toISOString() },
            { rung: "window-sampling", sourceId: "tmux:window-activity", trust: "authoritative", lastEvidenceAt: new Date().toISOString() },
          ],
          lastSwap: null,
        }),
      };
      const entries = new PsProjectionService({ db, agentActivity: store, seatActivity: seatActivity as never }).getEntries();
      expect(entries.find((e) => e.rigId === rigId)!.attentionCount).toBe(1);
    });

    it("getEntries: store absent -> needs_input contributes false (honest degrade), other signals still count", () => {
      const rigId = seedRig("attn-nostore");
      const n = seedNode(rigId, "dev");
      db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
        .run("s-ns", n, "dev@attn-nostore", "exited", "failed");
      const entries = ps.getEntries(); // `ps` has no agentActivity store
      expect(entries.find((e) => e.rigId === rigId)!.attentionCount).toBe(1);
    });

    it("attentionCount is ADDITIVE: every pre-existing PsEntry key is preserved (RPS-2)", () => {
      const rigId = seedRig("attn-keys");
      const n = seedNode(rigId, "dev");
      seedSession(n, "running");
      const entry = ps.getEntries().find((e) => e.rigId === rigId)!;
      for (const key of ["rigId", "name", "rigName", "nodeCount", "runningCount", "activeCount", "hasWorkCount",
        "status", "lifecycleState", "uptime", "latestSnapshot", "archivedAt", "isArchived",
        "periodicSnapshotActive", "periodicSnapshotIntervalSeconds", "autoPeriodicSnapshotCount"]) {
        expect(Object.prototype.hasOwnProperty.call(entry, key), key).toBe(true);
      }
      expect(typeof entry.attentionCount).toBe("number");
      expect(JSON.stringify(entry)).not.toContain("resumeToken");
    });
  });
});

// ===================================================================
// SLICE-05 item-5 (D5) — ps must not fabricate a dead seat as running.
// The persisted status stays running after an out-of-band tmux teardown.
// Effective counts and lifecycle must honor the applicable absence verdict
// while keeping the registration intact. Self-contained (own db).
// ===================================================================
describe("Slice-05 item-5 (D5) — ps running honesty vs identity verdict", () => {
  it("a running session with an applicable session_missing verdict is not counted running", () => {
    const db = createFullTestDb();
    try {
      db.prepare("INSERT INTO rigs (id, name) VALUES ('r-d5','d5')").run();
      db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('n-d5','r-d5','dev','claude-code','/tmp')").run();
      db.prepare(
        "INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES ('s-d5','n-d5','tmux-n-d5','running','2026-07-02 12:00:00')",
      ).run();
      // A CURRENT binding so the verdict is APPLICABLE (applicableVerdict requires
      // verdict.sessionName === latest session_name AND registeredPane === binding tmux_pane).
      db.prepare(
        "INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES ('b-d5','n-d5','tmux','tmux-n-d5','%1')",
      ).run();
      // The live tmux session is gone; the reconciler recorded session_missing against THIS binding.
      new SeatIdentityStore(db).upsert({
        nodeId: "n-d5",
        verdict: "pane_missing",
        evidenceSource: "tmux_session",
        reason: "session_missing",
        evidence: { registeredPane: "%1", observedPid: null, observedCommand: null, matchedLayer: null },
        sessionName: "tmux-n-d5",
        observedAt: "2026-07-02T12:00:00.000Z",
      });
      const entry = new PsProjectionService({ db }).getEntries()[0]!;
      expect(entry.lifecycleState).toBe("stopped");
      expect(entry.runningCount).toBe(0);
      expect(entry.activeCount).toBe(0);
      expect(entry.status).toBe("stopped");
      expect(db.prepare("SELECT status FROM sessions WHERE id = 's-d5'").get()).toEqual({ status: "running" });
    } finally {
      db.close();
    }
  });
});

describe("#3636 — the ps projection folds only the rigs it returns", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createFullTestDb();
    vi.mocked(getNodeInventoryForAllRigs).mockClear();
    vi.mocked(getNodeInventoryForRigs).mockClear();
  });

  afterEach(() => { vi.useRealTimers(); db.close(); });

  function seedRunningRig(
    name: string,
    opts: { id?: string; archived?: boolean; latest?: "running" | "stopped" } = {},
  ): { rigId: string; nodeId: string } {
    const rigId = opts.id ?? `rig-${name}`;
    const nodeId = `node-${rigId}`;
    db.prepare("INSERT INTO rigs (id, name, archived_at) VALUES (?, ?, ?)")
      .run(rigId, name, opts.archived ? "2026-11-20 00:00:00" : null);
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES (?, ?, 'dev', 'claude-code', '/tmp')").run(nodeId, rigId);
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, 'running', '2026-11-20 12:00:00')")
      .run(sessionId(), nodeId, `tmux-${rigId}`);
    if (opts.latest === "stopped") {
      db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, 'stopped', '2026-11-20 13:00:00')")
        .run(sessionId(), nodeId, `tmux-${rigId}`);
    }
    return { rigId, nodeId };
  }

  it("the default projection builds the inventory only for the active rigs, with the same entries as before", () => {
    const active = seedRunningRig("active");
    const archived = seedRunningRig("archived", { archived: true });
    // One name, three rigs: two active generations and one archived.
    const twinA = seedRunningRig("twin", { id: "rig-twin-a" });
    const twinB = seedRunningRig("twin", { id: "rig-twin-b" });
    const twinOld = seedRunningRig("twin", { id: "rig-twin-old", archived: true });
    const ps = new PsProjectionService({ db });
    // One clock for both projections, so uptime can't roll over between them.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-21T00:00:00.000Z"));

    const entries = ps.getEntries();

    expect(vi.mocked(getNodeInventoryForAllRigs)).not.toHaveBeenCalled();
    expect(vi.mocked(getNodeInventoryForRigs)).toHaveBeenCalledTimes(1);
    expect([...vi.mocked(getNodeInventoryForRigs).mock.calls[0]![1]].sort()).toEqual([active.rigId, twinA.rigId, twinB.rigId].sort());
    expect(entries.map((e) => [e.rigId, e.runningCount]).sort()).toEqual(
      [[active.rigId, 1], [twinA.rigId, 1], [twinB.rigId, 1]].sort(),
    );
    // Same per-rig entries the unscoped (all-rigs) pass gives.
    expect(entries).toEqual(ps.getEntries({ includeArchived: true }).filter((e) => !e.isArchived));

    vi.mocked(getNodeInventoryForRigs).mockClear();
    const archivedEntries = ps.getEntries({ archivedOnly: true });
    expect(archivedEntries.map((e) => [e.rigId, e.runningCount]).sort()).toEqual([[archived.rigId, 1], [twinOld.rigId, 1]].sort());
    expect([...vi.mocked(getNodeInventoryForRigs).mock.calls[0]![1]].sort()).toEqual([archived.rigId, twinOld.rigId].sort());
    expect(archivedEntries).toEqual(ps.getEntries({ includeArchived: true }).filter((e) => e.isArchived));
  });

  it("countRunningSeats equals the includeArchived runningCount sum and folds only rigs with a running latest registration", () => {
    const active = seedRunningRig("active");
    const archived = seedRunningRig("archived", { archived: true }); // forced archival: still running, still counted
    seedRunningRig("stopped-now", { latest: "stopped" });            // an older running row doesn't count
    const gone = seedRunningRig("gone");                             // running row, but the session is confirmed missing
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES ('b-gone', ?, 'tmux', 'tmux-rig-gone', '%1')")
      .run(gone.nodeId);
    new SeatIdentityStore(db).upsert({
      nodeId: gone.nodeId,
      verdict: "pane_missing",
      evidenceSource: "tmux_session",
      reason: "session_missing",
      evidence: { registeredPane: "%1", observedPid: null, observedCommand: null, matchedLayer: null },
      sessionName: "tmux-rig-gone",
      // After the ULID registration time, so the verdict applies to this session.
      observedAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const ps = new PsProjectionService({ db });

    const count = ps.countRunningSeats();

    expect(count).toBe(2);
    expect(vi.mocked(getNodeInventoryForAllRigs)).not.toHaveBeenCalled();
    expect([...vi.mocked(getNodeInventoryForRigs).mock.calls[0]![1]].sort()).toEqual([active.rigId, archived.rigId, gone.rigId].sort());
    expect(count).toBe(ps.getEntries({ includeArchived: true }).reduce((n, entry) => n + entry.runningCount, 0));
  });
});
