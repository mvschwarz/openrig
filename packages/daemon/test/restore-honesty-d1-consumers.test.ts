// OPR.0.5.7.1 — D1 CONSUMER ALIGNMENT (R2 HOLD repair; territory ruling on
// qitem-20260829091346-bfdaaca8). Execution resolves the active occupant from
// SnapshotData.activeSessionIdByNode; these tests pin the SAME occupant truth
// onto the three reporting consumers that still select historical rows
// independently: restore-plan preview (max-ULID reduce), snapshot usability
// (any-historical-token), and lifecycle recoverability (first-row find).
//
// Ruled broken-relation vocabulary: intendedAction "awaiting-decision",
// freshRequired false (--fresh cannot override A1 ambiguity), a reason naming
// the relation failure, token truth derived from NO resolved occupant — never
// from a historical row.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { findLatestUsableSnapshot } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { buildRestorePlanPreview, collectPreviewSessionRows } from "../src/domain/restore-plan-preview.js";
import { deriveNodeLifecycleState } from "../src/domain/node-inventory.js";
import type { Snapshot, SnapshotData, Session } from "../src/domain/types.js";
import { createFullTestDb } from "./helpers/test-app.js";

// ULIDs where lexical order is the trap: OLD sorts before NEW, so the retired
// "latest = max id" selection picks NEW.
const ULID_OLD = "01ARZ3NDEKTSV4RRFFQ69G5AAA";
const ULID_NEW = "01ARZ3NDEKTSV4RRFFQ69G5ZZZ";
const ULID_GONE = "01ARZ3NDEKTSV4RRFFQ69G5XXX";

type FixtureRow = { id: string; status: string; token: string | null; type?: string | null };

function sessionRow(nodeId: string, r: FixtureRow): Session {
  return {
    id: r.id,
    nodeId,
    sessionName: "r77-seat",
    status: r.status,
    resumeType: r.type === undefined ? "claude_name" : r.type,
    resumeToken: r.token,
    restorePolicy: "resume_if_possible",
    lastSeenAt: null,
    createdAt: "2026-08-29 00:00:00",
    origin: "launched",
    startupStatus: "ready",
    startupCompletedAt: null,
  } as Session;
}

type RelationMode =
  | { mode: "field-absent" }
  | { mode: "explicit-null" }
  | { mode: "missing-node-key" }
  | { mode: "explicit-id"; id: string }
  | { mode: "dangling-id"; id: string };

function snapshotData(rigId: string, nodeId: string, rows: FixtureRow[], relation: RelationMode, rig: { rig: unknown; nodes: unknown[]; edges: unknown[] }): SnapshotData {
  const data: SnapshotData = {
    rig: rig.rig as SnapshotData["rig"],
    nodes: rig.nodes as SnapshotData["nodes"],
    edges: rig.edges as SnapshotData["edges"],
    sessions: rows.map((r) => sessionRow(nodeId, r)),
    checkpoints: {},
  };
  switch (relation.mode) {
    case "field-absent":
      break;
    case "explicit-null":
      data.activeSessionIdByNode = { [nodeId]: null };
      break;
    case "missing-node-key":
      data.activeSessionIdByNode = { "some-other-node": null };
      break;
    case "explicit-id":
    case "dangling-id":
      data.activeSessionIdByNode = { [nodeId]: relation.id };
      break;
  }
  return data;
}

describe("OPR.0.5.7.1 — D1 consumer alignment (preview / usability / lifecycle)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let snapshotCapture: SnapshotCapture;
  let snapshotRepo: SnapshotRepository;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  });

  afterEach(() => {
    db.close();
  });

  function seedRig() {
    const rig = rigRepo.createRig("r77");
    const node = rigRepo.addNode(rig.id, "seat", { role: "worker", runtime: "claude-code" });
    const rigW = rigRepo.getRig(rig.id)!;
    return { rigId: rig.id, nodeId: node.id, rigW };
  }

  function makeSnapshot(rigId: string, data: SnapshotData): Snapshot {
    return { id: "snap-test-1", rigId, kind: "manual", status: "ok", data, createdAt: "2026-08-29 00:00:00" };
  }

  function previewNode(rigW: ReturnType<RigRepository["getRig"]> & object, snapshot: Snapshot | null, freshLogicalIds?: string[]) {
    const rows = collectPreviewSessionRows(db, rigW as never, snapshot);
    const plan = buildRestorePlanPreview(rigW as never, snapshot, rows, freshLogicalIds);
    const node = plan.nodes.find((n) => n.logicalId === "seat");
    expect(node).toBeDefined();
    return node!;
  }

  // ------------------------------------------------------------ preview ---

  it("R-A: the explicit relation selects the older ACTIVE row over a newer superseded tokenless row — action AND token state (incident order: newer row first)", () => {
    const { rigId, nodeId, rigW } = seedRig();
    const data = snapshotData(rigId, nodeId, [
      { id: ULID_NEW, status: "superseded", token: null },      // newer, first in array
      { id: ULID_OLD, status: "running", token: "tok-active" }, // the occupant
    ], { mode: "explicit-id", id: ULID_OLD }, rigW as never);
    const node = previewNode(rigW, makeSnapshot(rigId, data));
    // base: max-ULID reduce picks the newer tokenless row → awaiting-decision + missing
    expect(node.intendedAction).toBe("resume-original");
    expect(node.tokenState).toBe("unverified"); // the OCCUPANT's token truth, never the historical row's
    expect(node.freshRequired).toBe(false);
  });

  it.each([
    ["explicit-null", { mode: "explicit-null" } as RelationMode],
    ["missing-node-key", { mode: "missing-node-key" } as RelationMode],
    ["dangling-id", { mode: "dangling-id", id: ULID_GONE } as RelationMode],
  ])("R-B (%s): a broken authoritative relation renders awaiting-decision, freshRequired=false, reason names the relation — and --fresh cannot override it", (_label, relation) => {
    const { rigId, nodeId, rigW } = seedRig();
    const data = snapshotData(rigId, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-live" },
    ], relation, rigW as never);
    for (const fresh of [undefined, ["seat"]]) {
      const node = previewNode(rigW, makeSnapshot(rigId, data), fresh);
      // base: without --fresh the reduce resumes the historical row; with
      // --fresh it short-circuits to fresh-primed. Both are the defect.
      expect(node.intendedAction).toBe("awaiting-decision");
      expect(node.freshRequired).toBe(false);
      expect(node.reason ?? "").toMatch(/relation|occupant/i);
      // token truth derives from NO resolved occupant — never the historical row
      expect(node.tokenState).toBe("missing");
    }
  });

  // ---------------------------------------------------------- lifecycle ---

  it("R-C: lifecycle recoverability follows the explicitly related ACTIVE row even when it is not first in the session array", () => {
    const { rigId, nodeId, rigW } = seedRig();
    const data = snapshotData(rigId, nodeId, [
      { id: ULID_NEW, status: "superseded", token: null }, // first row, no token
      { id: ULID_OLD, status: "running", token: "tok-active" },
    ], { mode: "explicit-id", id: ULID_OLD }, rigW as never);
    const state = deriveNodeLifecycleState({
      sessionStatus: "exited",
      restoreOutcome: "n-a",
      nodeId,
      usableSnapshot: makeSnapshot(rigId, data),
    });
    // base: first-row .find sees no token → detached
    expect(state).toBe("recoverable");
  });

  // ---------------------------------------------------------- usability ---

  it("R-D: present-null with a historical token is NOT usable and NOT recoverable", () => {
    const { rigId, nodeId, rigW } = seedRig();
    const data = snapshotData(rigId, nodeId, [
      { id: ULID_OLD, status: "exited", token: "tok-historical" },
    ], { mode: "explicit-null" }, rigW as never);
    db.prepare("INSERT INTO snapshots (id, rig_id, kind, status, data, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
      .run("snap-null-1", rigId, "manual", "ok", JSON.stringify(data));
    // base: any-historical-token predicate reads this snapshot as usable
    expect(findLatestUsableSnapshot(db, rigId)).toBeNull();
    const state = deriveNodeLifecycleState({
      sessionStatus: "exited",
      restoreOutcome: "n-a",
      nodeId,
      usableSnapshot: makeSnapshot(rigId, data),
    });
    expect(state).not.toBe("recoverable");
  });

  // --------------------------------------------- live no-snapshot parity ---

  it("R-E1: live preview (no snapshot) selects the exactly-one-RUNNING row as the occupant, not the newest row", () => {
    const { rigW, nodeId } = seedRig();
    const s1 = sessionRegistry.registerSession(nodeId, "r77-seat");
    sessionRegistry.updateStatus(s1.id, "running");
    db.prepare("UPDATE sessions SET resume_type = 'claude_name', resume_token = 'tok-active' WHERE id = ?").run(s1.id);
    const s2 = sessionRegistry.registerSession(nodeId, "r77-seat-v2"); // newer ULID, status unknown, no token
    expect(s2.id > s1.id).toBe(true);
    const node = previewNode(rigW, null);
    // base: the live SELECT carries no status; the reduce picks the newer
    // tokenless row → fresh-primed/missing
    expect(node.intendedAction).toBe("resume-original");
    expect(node.tokenState).toBe("unverified");
  });

  it("R-E2: live preview with zero-or-several RUNNING rows is explicit-null ambiguity — awaiting-decision, freshRequired=false (capture parity)", () => {
    const { rigW, nodeId } = seedRig();
    const s1 = sessionRegistry.registerSession(nodeId, "r77-seat");
    const s2 = sessionRegistry.registerSession(nodeId, "r77-seat-v2");
    sessionRegistry.updateStatus(s1.id, "running");
    sessionRegistry.updateStatus(s2.id, "running");
    db.prepare("UPDATE sessions SET resume_type = 'claude_name', resume_token = 'tok-a' WHERE id = ?").run(s1.id);
    const node = previewNode(rigW, null);
    expect(node.intendedAction).toBe("awaiting-decision");
    expect(node.freshRequired).toBe(false);
    expect(node.tokenState).toBe("missing");
  });

  it("R-E3 parity floor: preview over the CAPTURED snapshot and preview over the same live state agree per node", () => {
    const { rigId, rigW, nodeId } = seedRig();
    const s1 = sessionRegistry.registerSession(nodeId, "r77-seat");
    sessionRegistry.updateStatus(s1.id, "running");
    db.prepare("UPDATE sessions SET resume_type = 'claude_name', resume_token = 'tok-active' WHERE id = ?").run(s1.id);
    const snap = snapshotCapture.captureSnapshot(rigId, "manual");
    const live = previewNode(rigW, null);
    const fromSnapshot = previewNode(rigW, snapshotRepo.getSnapshot(snap.id)!);
    expect(live.intendedAction).toBe(fromSnapshot.intendedAction);
    expect(live.tokenState).toBe(fromSnapshot.tokenState);
    expect(live.freshRequired).toBe(fromSnapshot.freshRequired);
  });

  // -------------------------------------------------------- legacy floor ---

  it("R-F1 floor: whole-field-absent legacy snapshot with a SINGLE row previews from that row (legacy inference intact)", () => {
    const { rigId, nodeId, rigW } = seedRig();
    const data = snapshotData(rigId, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-active" },
    ], { mode: "field-absent" }, rigW as never);
    const node = previewNode(rigW, makeSnapshot(rigId, data));
    expect(node.intendedAction).toBe("resume-original");
    expect(node.tokenState).toBe("unverified");
  });

  it("R-F2 alignment: whole-field-absent legacy snapshot with several rows previews from the UNIQUELY-RUNNING row, never the newest ULID", () => {
    // Honest RED note: at base this leg fails — the preview reduce is the very
    // divergence under repair. It is titled alignment, not floor.
    const { rigId, nodeId, rigW } = seedRig();
    const data = snapshotData(rigId, nodeId, [
      { id: ULID_NEW, status: "superseded", token: null },
      { id: ULID_OLD, status: "running", token: "tok-active" },
    ], { mode: "field-absent" }, rigW as never);
    const node = previewNode(rigW, makeSnapshot(rigId, data));
    expect(node.intendedAction).toBe("resume-original");
    expect(node.tokenState).toBe("unverified");
  });
});
