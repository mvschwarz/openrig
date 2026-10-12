// OPR.0.4.3.19 — liveness identity projection gating.
//
// A persisted identity verdict of `mismatch`/`pane_missing` must down-rank a
// `running` session away from running/active across node-inventory (which
// feeds `rig ps --nodes` + node detail) and the topology graph — carrying the
// evidence. `verified`, `tmux_unavailable`, and an ABSENT verdict must leave
// the existing projection unchanged (no false-green flip; no-regression).

import { describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import { ulid } from "ulid";
import { createFullTestDb } from "./helpers/test-app.js";
import { getNodeInventory, getNodeInventoryForAllRigs, getNodeInventoryForRigs, getNodeDetail, deriveNodeLifecycleState, attachAgentActivity, attachTerminalActivityAndWork } from "../src/domain/node-inventory.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { projectRigToGraph, type InventoryOverlay } from "../src/domain/graph-projection.js";
import type { SeatIdentityVerdict, SeatIdentityVerdictKind } from "../src/domain/types.js";
import { identityVerdictDownranksRunning } from "../src/domain/types.js";

function seedRunningSeat(db: Database.Database): void {
  db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1','test-rig')").run();
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('n1','rig-1','dev.impl','claude-code','/tmp')").run();
  db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, created_at) VALUES ('sess1','n1','dev-impl@rig','running','ready','2026-07-01 00:00:00')").run();
  db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES ('bind1','n1','tmux','dev-impl@rig','%1')").run();
}

function verdict(kind: SeatIdentityVerdictKind, reason: SeatIdentityVerdict["reason"] = null): SeatIdentityVerdict {
  return {
    nodeId: "n1",
    verdict: kind,
    evidenceSource: kind === "verified" ? "pane_process" : (reason === "session_missing" ? "tmux_session" : "pane_process"),
    reason,
    evidence: { registeredPane: "%1", observedPid: 1, observedCommand: "zsh", matchedLayer: 1 },
    sessionName: "dev-impl@rig",
    observedAt: "2026-07-02T12:00:00.000Z",
  };
}

describe("deriveNodeLifecycleState identity gate (unit)", () => {
  const base = { restoreOutcome: "n-a" as const, nodeId: "n1", usableSnapshot: null };

  it("running + verified → running", () => {
    expect(deriveNodeLifecycleState({ ...base, sessionStatus: "running", identityVerdict: "verified" })).toBe("running");
  });
  it("running + absent verdict → running (no false flip)", () => {
    expect(deriveNodeLifecycleState({ ...base, sessionStatus: "running", identityVerdict: null })).toBe("running");
    expect(deriveNodeLifecycleState({ ...base, sessionStatus: "running" })).toBe("running");
  });
  it("running + tmux_unavailable → running (transient blip is not a mismatch)", () => {
    expect(deriveNodeLifecycleState({ ...base, sessionStatus: "running", identityVerdict: "tmux_unavailable" })).toBe("running");
  });
  it("running + binding_absent → running (live target with missing binding is named but non-down-ranking)", () => {
    expect(identityVerdictDownranksRunning("binding_absent")).toBe(false);
    expect(deriveNodeLifecycleState({ ...base, sessionStatus: "running", identityVerdict: "binding_absent" })).toBe("running");
  });
  it("running + startup attention → attention_required", () => {
    expect(deriveNodeLifecycleState({ ...base, sessionStatus: "running", startupStatus: "attention_required" })).toBe("attention_required");
  });
  it("running + mismatch → attention_required", () => {
    expect(deriveNodeLifecycleState({ ...base, sessionStatus: "running", identityVerdict: "mismatch" })).toBe("attention_required");
  });
  it("running + pane_missing → attention_required", () => {
    expect(deriveNodeLifecycleState({ ...base, sessionStatus: "running", identityVerdict: "pane_missing" })).toBe("attention_required");
  });
});

describe("getNodeInventory identity gating", () => {
  it.each(["claude-code", "codex"])("%s startup status follows current identity in list and detail, preserving the stored result", runtime => {
    const db = createFullTestDb();
    try {
      seedRunningSeat(db);
      db.prepare("UPDATE nodes SET runtime = ? WHERE id = 'n1'").run(runtime);
      const identities = new SeatIdentityStore(db);
      for (const kind of ["mismatch", "pane_missing"] as const) {
        identities.upsert(verdict(kind));
        expect(getNodeInventory(db, "rig-1")[0].startupStatus).toBe("attention_required");
        expect(getNodeDetail(db, "rig-1", "dev.impl")?.startupStatus).toBe("attention_required");
        expect(db.prepare("SELECT startup_status FROM sessions WHERE id = 'sess1'").get())
          .toEqual({ startup_status: "ready" });
      }
      identities.upsert(verdict("verified"));
      expect(getNodeInventory(db, "rig-1")[0].startupStatus).toBe("ready");
      // Process identity alone cannot erase a real startup/context-delivery failure.
      db.prepare("UPDATE sessions SET startup_status = 'failed' WHERE id = 'sess1'").run();
      expect(getNodeInventory(db, "rig-1")[0].startupStatus).toBe("failed");
      db.prepare("UPDATE sessions SET status = 'stopped' WHERE id = 'sess1'").run();
      identities.upsert(verdict("pane_missing"));
      expect(getNodeInventory(db, "rig-1")[0].startupStatus).toBe("failed");
    } finally {
      db.close();
    }
  });

  it("no verdict → running/active + null identityVerdict (no-regression)", () => {
    const db = createFullTestDb();
    seedRunningSeat(db);
    const [n] = getNodeInventory(db, "rig-1");
    expect(n.lifecycleState).toBe("running");
    expect(n.occupantLifecycle).toBe("active");
    expect(n.identityVerdict).toBeNull();
    expect(n.startupStatus).toBe("ready");
    db.close();
  });

  it("verified verdict → running/active, verdict surfaced", () => {
    const db = createFullTestDb();
    seedRunningSeat(db);
    new SeatIdentityStore(db).upsert(verdict("verified"));
    const [n] = getNodeInventory(db, "rig-1");
    expect(n.lifecycleState).toBe("running");
    expect(n.occupantLifecycle).toBe("active");
    expect(n.identityVerdict?.verdict).toBe("verified");
    expect(n.startupStatus).toBe("ready");
    db.close();
  });

  it("MISMATCH verdict → NOT running/active; evidence surfaced", () => {
    const db = createFullTestDb();
    seedRunningSeat(db);
    new SeatIdentityStore(db).upsert(verdict("mismatch", "process_identity_mismatch"));
    const [n] = getNodeInventory(db, "rig-1");
    expect(n.lifecycleState).toBe("attention_required");
    expect(n.occupantLifecycle).toBe("unknown");
    expect(n.sessionStatus).toBe("running"); // raw session row unchanged
    expect(n.identityVerdict?.reason).toBe("process_identity_mismatch");
    expect(n.identityVerdict?.evidence.registeredPane).toBe("%1");
    db.close();
  });

  it("confirmed missing session projects detached without rewriting history or stored occupant state", () => {
    const db = createFullTestDb();
    seedRunningSeat(db);
    db.prepare("UPDATE nodes SET occupant_lifecycle = 'active' WHERE id = 'n1'").run();
    const stored = db.prepare("SELECT * FROM sessions WHERE id = 'sess1'").get();
    new SeatIdentityStore(db).upsert(verdict("pane_missing", "session_missing"));
    const [n] = getNodeInventory(db, "rig-1");
    expect(n.lifecycleState).toBe("detached");
    expect(n.sessionStatus).toBe("detached");
    expect(n.storedSessionStatus).toBe("running");
    expect(n.startupStatus).toBe("ready");
    expect(n.storedStartupStatus).toBe("ready");
    expect(getNodeDetail(db, "rig-1", "dev.impl")).toMatchObject({
      sessionStatus: "detached", storedSessionStatus: "running",
      lifecycleState: "detached", occupantLifecycle: "unknown",
      identityVerdict: n.identityVerdict,
    });
    expect(getNodeInventoryForAllRigs(db).get("rig-1")).toEqual([n]);
    expect(getNodeInventoryForRigs(db, new Set(["rig-1"])).get("rig-1")).toEqual([n]);
    expect(db.prepare("SELECT * FROM sessions WHERE id = 'sess1'").get()).toEqual(stored);
    expect(db.prepare("SELECT occupant_lifecycle FROM nodes WHERE id = 'n1'").get()).toEqual({ occupant_lifecycle: "active" });
    expect(n.occupantLifecycle).toBe("unknown");
    expect(n.identityVerdict?.reason).toBe("session_missing");
    db.close();
  });

  it("matching NULL-pane binding_absent verdict is visible but leaves running/active unchanged", () => {
    const db = createFullTestDb();
    seedRunningSeat(db);
    db.prepare("UPDATE bindings SET tmux_pane = NULL WHERE node_id = 'n1'").run();
    new SeatIdentityStore(db).upsert({
      ...verdict("binding_absent", "binding_pane_missing"),
      evidence: { registeredPane: null, observedPid: null, observedCommand: null, matchedLayer: null },
    });
    const [n] = getNodeInventory(db, "rig-1");
    expect(n.identityVerdict?.verdict).toBe("binding_absent");
    expect(n.identityVerdict?.reason).toBe("binding_pane_missing");
    expect(n.lifecycleState).toBe("running");
    expect(n.occupantLifecycle).toBe("active");
    db.close();
  });

  it("matching NULL-pane session_missing verdict projects detached", () => {
    const db = createFullTestDb();
    seedRunningSeat(db);
    db.prepare("UPDATE bindings SET tmux_pane = NULL WHERE node_id = 'n1'").run();
    expect(identityVerdictDownranksRunning("pane_missing")).toBe(true);
    new SeatIdentityStore(db).upsert({
      ...verdict("pane_missing", "session_missing"),
      evidence: { registeredPane: null, observedPid: null, observedCommand: null, matchedLayer: null },
    });
    const [n] = getNodeInventory(db, "rig-1");
    expect(n.identityVerdict?.verdict).toBe("pane_missing");
    expect(n.lifecycleState).toBe("detached");
    expect(n.sessionStatus).toBe("detached");
    expect(n.occupantLifecycle).toBe("unknown");
    db.close();
  });

  it("liveness is not from heartbeats — an active queue heartbeat does NOT upgrade a mismatched seat", () => {
    const db = createFullTestDb();
    seedRunningSeat(db);
    // Pending qitem for the seat (hasAssignedWork would be true), yet the pane
    // identity mismatches → still non-green. The verdict wins, not the heartbeat.
    db.prepare(
      "INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("q1", "2026-07-02T12:00:00Z", "2026-07-02T12:00:00Z", "op@rig", "dev-impl@rig", "pending", "work");
    new SeatIdentityStore(db).upsert(verdict("mismatch", "process_identity_mismatch"));
    const [n] = getNodeInventory(db, "rig-1");
    expect(n.lifecycleState).toBe("attention_required");
    db.close();
  });

  it.each([
    ["tmux_unavailable", "tmux_unavailable"],
    ["pane_missing", "pane_pid_gone"],
    ["mismatch", "process_identity_mismatch"],
  ] as const)("%s/%s does not prove the session missing", (kind, reason) => {
    const db = createFullTestDb();
    try {
      seedRunningSeat(db);
      new SeatIdentityStore(db).upsert(verdict(kind, reason));
      const [entry] = getNodeInventory(db, "rig-1");
      expect(entry.sessionStatus).toBe("running");
      expect(entry.storedSessionStatus).toBe("running");
      if (kind === "tmux_unavailable") expect(entry.lifecycleState).toBe("running");
    } finally { db.close(); }
  });

  it("confirmed absence outranks fresh hook, structural, motion and taxonomy caches but retains assigned work", async () => {
    const db = createFullTestDb();
    try {
      seedRunningSeat(db);
      new SeatIdentityStore(db).upsert(verdict("pane_missing", "session_missing"));
      db.prepare("INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body) VALUES ('q1', '2026-07-02', '2026-07-02', 'op@rig', 'dev-impl@rig', 'pending', 'work')").run();
      const seatActivity = {
        getSeatActivity: () => ({ isActiveWithinWindow: true, lastActivityAt: "2026-07-02T12:00:00.000Z", silenceWindowSeconds: 60 }),
        getSeatStateBySession: () => ({ activity: "working", needsInput: { count: 0, reason: null } }),
      };
      const entries = await attachAgentActivity(getNodeInventory(db, "rig-1"), {
        tmuxAdapter: { capturePaneContent: () => { throw new Error("missing session must not be captured"); } } as never,
        activityStore: { getLatestForNode: () => ({ state: "running", reason: "hook" }) } as never,
        structuralActivity: { getStructuralActivity: () => ({ state: "mid_work" }) } as never,
        seatActivity: seatActivity as never,
        captureFallback: true,
        now: new Date("2026-07-02T12:00:01.000Z"),
      });
      const [entry] = attachTerminalActivityAndWork(entries, { db, seatActivity: seatActivity as never });
      expect(entry).toMatchObject({
        sessionStatus: "detached", terminalActive: false, activityState: null, lastActivityAt: null,
        hasAssignedWork: true, pendingWorkCount: 1,
        agentActivity: { state: "unknown", reason: "session_missing", evidenceSource: "tmux_session" },
      });
    } finally { db.close(); }
  });
});

describe("getNodeInventory verdict applicability gate (rev1-r2 B1 — no stale false-green)", () => {
  it.each(["session", "pane", "registration", "handover", "ulid"])("stale missing verdict cannot detach a current occupant after %s changes", changed => {
    const db = createFullTestDb();
    try {
      seedRunningSeat(db);
      new SeatIdentityStore(db).upsert(verdict("pane_missing", "session_missing"));
      if (changed === "session") db.prepare("UPDATE sessions SET session_name = 'new-seat@rig' WHERE id = 'sess1'").run();
      if (changed === "pane") db.prepare("UPDATE bindings SET tmux_pane = '%2' WHERE node_id = 'n1'").run();
      if (changed === "registration") db.prepare("UPDATE sessions SET created_at = '2026-07-02 12:00:01' WHERE id = 'sess1'").run();
      if (changed === "handover") db.prepare("UPDATE nodes SET handover_at = '2026-07-02T12:00:00.000Z' WHERE id = 'n1'").run();
      if (changed === "ulid") db.prepare("UPDATE sessions SET id = ? WHERE id = 'sess1'").run(ulid(Date.parse("2026-07-02T12:00:00.000Z")));
      expect(getNodeInventory(db, "rig-1")[0]).toMatchObject({
        identityVerdict: null, sessionStatus: "running", lifecycleState: "running", occupantLifecycle: "active",
      });
    } finally { db.close(); }
  });

  it.each(["retained", "finishes after cutover"])("same-pane successor rejects predecessor evidence: %s", timing => {
    const db = createFullTestDb();
    try {
      seedRunningSeat(db);
      const store = new SeatIdentityStore(db);
      const old = { ...verdict("mismatch", "process_identity_ambiguous"), observedAt: "2026-07-02T12:00:00.100Z" };
      if (timing === "retained") store.upsert(old);
      // The cutover keeps the canonical name and pane, supersedes the session,
      // and records a handover within the same SQLite timestamp second.
      db.prepare("UPDATE sessions SET status = 'superseded' WHERE id = 'sess1'").run();
      db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, created_at) VALUES ('sess2','n1','dev-impl@rig','running','ready','2026-07-02 12:00:00')").run();
      db.prepare("UPDATE nodes SET handover_at = '2026-07-02T12:00:00.200Z' WHERE id = 'n1'").run();
      if (timing === "finishes after cutover") store.upsert(old);
      for (const node of [getNodeInventory(db, "rig-1")[0], getNodeDetail(db, "rig-1", "dev.impl")!]) {
        expect(node.identityVerdict).toBeNull();
        expect(node.startupStatus).toBe("ready");
        expect(node.lifecycleState).toBe("running");
        expect(node.occupantLifecycle).toBe("active");
      }
      const overlay = getNodeInventory(db, "rig-1");
      const graph = projectRigToGraph({
        rig: { id: "rig-1", name: "test-rig" } as never,
        nodes: [{ id: "n1", rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" } as never],
        sessions: [{ id: "sess2", nodeId: "n1", sessionName: "dev-impl@rig", status: "running", startupStatus: "ready" } as never],
        pods: [], edges: [],
      }, overlay);
      expect(graph.nodes[0].data.startupStatus).toBe("ready");
      // A later observation of THIS occupant still down-ranks it.
      store.upsert({ ...old, observedAt: "2026-07-02T12:00:00.300Z" });
      expect(getNodeInventory(db, "rig-1")[0].startupStatus).toBe("attention_required");
      db.prepare("UPDATE sessions SET startup_status = 'failed' WHERE id = 'sess2'").run();
      store.upsert({ ...verdict("verified"), observedAt: "2026-07-02T12:00:00.400Z" });
      expect(getNodeInventory(db, "rig-1")[0].startupStatus).toBe("failed");
    } finally { db.close(); }
  });

  it("same-pane registration rejects observations older than the latest session", () => {
    const db = createFullTestDb();
    try {
      seedRunningSeat(db);
      db.prepare("UPDATE sessions SET created_at = '2026-07-02 12:00:01' WHERE id = 'sess1'").run();
      new SeatIdentityStore(db).upsert(verdict("pane_missing", "session_missing"));
      expect(getNodeInventory(db, "rig-1")[0].identityVerdict).toBeNull();
      expect(getNodeInventory(db, "rig-1")[0].startupStatus).toBe("ready");
    } finally { db.close(); }
  });

  it("same-pane cutover rejects equal-time observations without discarding later negatives", () => {
    const db = createFullTestDb();
    try {
      seedRunningSeat(db);
      db.prepare("UPDATE nodes SET handover_at = ? WHERE id = 'n1'").run(verdict("mismatch").observedAt);
      const store = new SeatIdentityStore(db);
      store.upsert(verdict("mismatch"));
      expect(getNodeInventory(db, "rig-1")[0].identityVerdict).toBeNull();
      store.upsert({ ...verdict("pane_missing", "session_missing"), observedAt: "2026-07-02T12:00:00.001Z" });
      expect(getNodeInventory(db, "rig-1")[0].sessionStatus).toBe("detached");
    } finally { db.close(); }
  });

  it("same-pane registration keeps millisecond precision within one SQLite second", () => {
    const db = createFullTestDb();
    try {
      seedRunningSeat(db);
      const createdAt = Date.parse("2026-07-02T12:00:00.200Z");
      db.prepare("UPDATE sessions SET id = ?, created_at = '2026-07-02 12:00:00' WHERE id = 'sess1'").run(ulid(createdAt));
      const store = new SeatIdentityStore(db);
      for (const offset of [-1, 0]) {
        store.upsert({ ...verdict("mismatch"), observedAt: new Date(createdAt + offset).toISOString() });
        expect(getNodeInventory(db, "rig-1")[0].identityVerdict).toBeNull();
      }
      store.upsert({ ...verdict("mismatch"), observedAt: new Date(createdAt + 1).toISOString() });
      expect(getNodeInventory(db, "rig-1")[0].startupStatus).toBe("attention_required");
    } finally { db.close(); }
  });

  // The durable verdict table is keyed ONLY by node_id. After a rebind/relaunch
  // the node keeps its id but gets a NEW session + NEW pane. A verdict computed
  // against the OLD session/pane must NOT be applied to the current binding: it
  // is treated as ABSENT (fail-open) — never surfaced, never down-ranks. Only a
  // verdict whose stored sessionName AND registeredPane match the current
  // binding is load-bearing.
  function staleVerdict(kind: SeatIdentityVerdictKind, reason: SeatIdentityVerdict["reason"] = null): SeatIdentityVerdict {
    return {
      nodeId: "n1",
      verdict: kind,
      evidenceSource: "pane_process",
      reason,
      // OLD session + OLD pane — the pre-rebind binding.
      evidence: { registeredPane: "%OLD", observedPid: 9, observedCommand: "zsh", matchedLayer: 1 },
      sessionName: "old-dev-impl@rig",
      observedAt: "2026-07-01T00:00:00.000Z",
    };
  }

  it("stale VERIFIED verdict (old session+pane) is NOT applied to the new binding — treated as ABSENT", () => {
    const db = createFullTestDb();
    seedRunningSeat(db); // current session dev-impl@rig, pane %1
    new SeatIdentityStore(db).upsert(staleVerdict("verified"));
    const [n] = getNodeInventory(db, "rig-1");
    // Fail-open + the stale `verified` is NOT surfaced (it would be a false
    // "verified" badge on a pane it was never computed against).
    expect(n.identityVerdict).toBeNull();
    expect(n.lifecycleState).toBe("running");
    db.close();
  });

  it("stale MISMATCH verdict (old session+pane) must NOT down-rank the new pane (no false-red)", () => {
    const db = createFullTestDb();
    seedRunningSeat(db);
    new SeatIdentityStore(db).upsert(staleVerdict("mismatch", "process_identity_mismatch"));
    const [n] = getNodeInventory(db, "rig-1");
    expect(n.identityVerdict).toBeNull();
    expect(n.lifecycleState).toBe("running"); // stale verdict does not apply
    expect(n.startupStatus).toBe("ready");
    expect(n.occupantLifecycle).toBe("active");
    db.close();
  });

  it("verdict matching session but STALE pane (pane-only rebind) is NOT applied — the AND gate is real", () => {
    const db = createFullTestDb();
    seedRunningSeat(db); // current pane %1
    new SeatIdentityStore(db).upsert({
      ...verdict("mismatch", "process_identity_mismatch"), // sessionName matches (dev-impl@rig)
      evidence: { registeredPane: "%OLD", observedPid: 9, observedCommand: "zsh", matchedLayer: 1 }, // ...but pane does not
    });
    const [n] = getNodeInventory(db, "rig-1");
    expect(n.identityVerdict).toBeNull();
    expect(n.lifecycleState).toBe("running");
    expect(n.startupStatus).toBe("ready");
    db.close();
  });

  it("CRITICAL — a MATCHING mismatch verdict still down-ranks (gate does not over-suppress)", () => {
    const db = createFullTestDb();
    seedRunningSeat(db);
    new SeatIdentityStore(db).upsert(verdict("mismatch", "process_identity_mismatch")); // session dev-impl@rig + pane %1 both match
    const [n] = getNodeInventory(db, "rig-1");
    expect(n.identityVerdict?.verdict).toBe("mismatch");
    expect(n.lifecycleState).toBe("attention_required");
    db.close();
  });

  it("CRITICAL — a MATCHING pane_missing verdict still down-ranks", () => {
    const db = createFullTestDb();
    seedRunningSeat(db);
    new SeatIdentityStore(db).upsert(verdict("pane_missing", "session_missing"));
    const [n] = getNodeInventory(db, "rig-1");
    expect(n.identityVerdict?.reason).toBe("session_missing");
    expect(n.lifecycleState).toBe("detached");
    db.close();
  });
});

describe("graph projection consumes the identity verdict (no false-green)", () => {
  // The exact incident shape: raw session status=running, overlay/startup
  // ready, terminalActive=true — a mismatch verdict must still make the graph
  // node non-green. The daemon synthesizes graph startupStatus=attention_required
  // so every UI ring (getBaselineActivityState checks attention_required BEFORE
  // terminalActive) renders non-green.
  function projectMismatchNode() {
    const overlay: InventoryOverlay[] = [{
      logicalId: "dev.impl",
      startupStatus: "ready", // startup says ready...
      canonicalSessionName: "dev-impl@rig",
      restoreOutcome: "n-a",
      terminalActive: true, // ...and the (orphan's) tmux output is active...
      identityVerdict: verdict("mismatch", "process_identity_mismatch"), // ...but identity mismatches.
    }];
    const graph = projectRigToGraph({
      rig: { id: "rig-1", name: "test-rig" } as never,
      nodes: [{ id: "n1", rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" } as never],
      edges: [],
      sessions: [{ id: "sess1", nodeId: "n1", sessionName: "dev-impl@rig", status: "running", startupStatus: "ready" } as never],
      pods: [],
    }, overlay);
    return graph.nodes.find((n) => n.id === "n1");
  }

  it("PRIMARY — mismatch + running + ready + terminalActive=true → graph node is NON-GREEN (startupStatus attention_required)", () => {
    const node = projectMismatchNode();
    // The no-green assertion: the effective graph startup status is
    // attention_required, which the UI ring treats as needs_input BEFORE it
    // ever consults terminalActive. So a mismatched seat cannot paint green.
    expect(node?.data.startupStatus).toBe("attention_required");
  });

  it("verified verdict leaves the graph node ready (no-regression)", () => {
    const overlay: InventoryOverlay[] = [{
      logicalId: "dev.impl", startupStatus: "ready", canonicalSessionName: "dev-impl@rig",
      restoreOutcome: "n-a", terminalActive: true, identityVerdict: verdict("verified"),
    }];
    const graph = projectRigToGraph({
      rig: { id: "rig-1", name: "test-rig" } as never,
      nodes: [{ id: "n1", rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" } as never],
      edges: [],
      sessions: [{ id: "sess1", nodeId: "n1", sessionName: "dev-impl@rig", status: "running", startupStatus: "ready" } as never],
      pods: [],
    }, overlay);
    expect(graph.nodes.find((n) => n.id === "n1")?.data.startupStatus).toBe("ready");
  });

  it("SECONDARY — the verdict is still exposed on the graph node data (evidence)", () => {
    const node = projectMismatchNode();
    expect(node?.data.identityVerdict?.verdict).toBe("mismatch");
    expect(node?.data.identityVerdict?.reason).toBe("process_identity_mismatch");
  });
});
