// OPR.0.4.3.19 — liveness identity projection gating.
//
// A persisted identity verdict of `mismatch`/`pane_missing` must down-rank a
// `running` session away from running/active across node-inventory (which
// feeds `rig ps --nodes` + node detail) and the topology graph — carrying the
// evidence. `verified`, `tmux_unavailable`, and an ABSENT verdict must leave
// the existing projection unchanged (no false-green flip; no-regression).

import { describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { getNodeInventory, deriveNodeLifecycleState } from "../src/domain/node-inventory.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { projectRigToGraph, type InventoryOverlay } from "../src/domain/graph-projection.js";
import type { SeatIdentityVerdict, SeatIdentityVerdictKind } from "../src/domain/types.js";

function seedRunningSeat(db: Database.Database): void {
  db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1','test-rig')").run();
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('n1','rig-1','dev.impl','claude-code','/tmp')").run();
  db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES ('sess1','n1','dev-impl@rig','running','ready')").run();
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
  it("running + mismatch → attention_required", () => {
    expect(deriveNodeLifecycleState({ ...base, sessionStatus: "running", identityVerdict: "mismatch" })).toBe("attention_required");
  });
  it("running + pane_missing → attention_required", () => {
    expect(deriveNodeLifecycleState({ ...base, sessionStatus: "running", identityVerdict: "pane_missing" })).toBe("attention_required");
  });
});

describe("getNodeInventory identity gating", () => {
  it("no verdict → running/active + null identityVerdict (no-regression)", () => {
    const db = createFullTestDb();
    seedRunningSeat(db);
    const [n] = getNodeInventory(db, "rig-1");
    expect(n.lifecycleState).toBe("running");
    expect(n.occupantLifecycle).toBe("active");
    expect(n.identityVerdict).toBeNull();
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

  it("PANE_MISSING verdict → NOT clean running; evidence names it missing", () => {
    const db = createFullTestDb();
    seedRunningSeat(db);
    new SeatIdentityStore(db).upsert(verdict("pane_missing", "session_missing"));
    const [n] = getNodeInventory(db, "rig-1");
    expect(n.lifecycleState).toBe("attention_required");
    expect(n.occupantLifecycle).toBe("unknown");
    expect(n.identityVerdict?.reason).toBe("session_missing");
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
});

describe("getNodeInventory verdict applicability gate (rev1-r2 B1 — no stale false-green)", () => {
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
    expect(n.lifecycleState).toBe("attention_required");
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
