import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { startupContextSchema } from "../src/db/migrations/015_startup_context.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import type { PersistedEvent } from "../src/domain/types.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { snapshotMatchesCurrentOccupants } from "../src/domain/rehydrate-eligibility.js";
import { buildRestorePlanPreview, collectPreviewSessionRows } from "../src/domain/restore-plan-preview.js";
import { readFreshOccupantRelations } from "../src/domain/fresh-occupant-relation.js";
import { deriveRehydrateOccupantsByNode } from "../src/domain/active-occupant.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

describe("SnapshotCapture", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let snapshotRepo: SnapshotRepository;
  let checkpointStore: CheckpointStore;
  let capture: SnapshotCapture;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    snapshotRepo = new SnapshotRepository(db);
    checkpointStore = new CheckpointStore(db);
    capture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  });

  afterEach(() => {
    db.close();
  });

  function seedRig() {
    const rig = rigRepo.createRig("r01");
    const n1 = rigRepo.addNode(rig.id, "orchestrator", { role: "orchestrator", runtime: "claude-code" });
    const n2 = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "codex" });
    rigRepo.addEdge(rig.id, n1.id, n2.id, "delegates_to");
    sessionRegistry.updateBinding(n1.id, { tmuxSession: "r99-demo1-lead", cmuxSurface: "s-1" });
    return { rig, n1, n2 };
  }

  it("does not collapse a dangling current effect into a never-occupied seat", () => {
    expect(deriveRehydrateOccupantsByNode([], ["n1"], { n1: "missing-session" }).n1).toEqual({ kind: "ambiguous", candidateIds: [] });
  });

  it("uses the current fresh effect consistently in reboot capture, live preview and snapshot matching", () => {
    const { rig, n1 } = seedRig();
    const old = sessionRegistry.registerSession(n1.id, "r99-demo1-lead");
    const successor = sessionRegistry.registerSession(n1.id, "r99-demo1-lead", "fresh");
    sessionRegistry.markDetached(old.id);
    sessionRegistry.markDetached(successor.id);
    sessionRegistry.updateResumeToken(successor.id, "claude_id", "native-successor", "hook");
    const generation = sessionRegistry.currentOccupantTenure(n1.id)!.generationUuid;
    const event = { nodeId: n1.id, sessionId: successor.id, newGeneration: generation };
    db.prepare("INSERT INTO events (rig_id, type, payload) VALUES (?, 'seat.fresh_launched', ?)").run(rig.id, JSON.stringify(event));
    const current = rigRepo.getRig(rig.id)!;
    const snapshot = capture.captureSnapshot(rig.id, "auto-rehydrate");
    expect(snapshot.data.activeOccupantsByNode?.[n1.id]).toEqual({ kind: "resolved", sessionId: successor.id });
    expect(snapshotMatchesCurrentOccupants(db, current, snapshot)).toBe(true);
    const preview = buildRestorePlanPreview(current, null, collectPreviewSessionRows(db, current, null), undefined, Date.now(), readFreshOccupantRelations(db, rig.id));
    expect(preview.nodes.find((node) => node.logicalId === n1.logicalId)).toMatchObject({ occupantSessionId: successor.id, intendedAction: "resume-original" });
    // Conflicting effects under the same generation cannot select either history.
    db.prepare("INSERT INTO events (rig_id, type, payload) VALUES (?, 'seat.fresh_launched', ?)").run(rig.id, JSON.stringify({ ...event, sessionId: old.id }));
    expect(snapshotMatchesCurrentOccupants(db, current, snapshot)).toBe(false);
    expect(capture.captureSnapshot(rig.id, "auto-rehydrate").data.activeOccupantsByNode?.[n1.id]?.kind).toBe("ambiguous");
  });

  it.each(["matching", "older session", "changed token", "changed type", "superseded", "dangling", "conflicting"])("checks a stopped fresh occupant against its pre-down snapshot: %s", (state) => {
    const { rig, n1 } = seedRig();
    const old = sessionRegistry.registerSession(n1.id, "r99-demo1-lead");
    sessionRegistry.updateStatus(old.id, "running");
    const oldSnapshot = capture.captureSnapshot(rig.id, "manual");
    sessionRegistry.updateStatus(old.id, "exited");
    const successor = sessionRegistry.registerSession(n1.id, "r99-demo1-lead", "fresh");
    sessionRegistry.updateStatus(successor.id, "running");
    sessionRegistry.updateResumeToken(successor.id, "claude_id", "native-successor", "hook");
    const event = { nodeId: n1.id, sessionId: successor.id, newGeneration: sessionRegistry.currentOccupantTenure(n1.id)!.generationUuid };
    db.prepare("INSERT INTO events (rig_id, type, payload) VALUES (?, 'seat.fresh_launched', ?)").run(rig.id, JSON.stringify(event));
    const snapshot = capture.captureSnapshot(rig.id, "auto-pre-down");
    sessionRegistry.updateStatus(successor.id, state === "superseded" ? "superseded" : "exited");

    if (state === "changed token") sessionRegistry.updateResumeToken(successor.id, "claude_id", "different-native", "hook");
    if (state === "changed type") db.prepare("UPDATE sessions SET resume_type = 'claude_name' WHERE id = ?").run(successor.id);
    if (state === "dangling") db.prepare("UPDATE events SET payload = ? WHERE type = 'seat.fresh_launched'").run(JSON.stringify({ ...event, sessionId: "missing" }));
    if (state === "conflicting") db.prepare("INSERT INTO events (rig_id, type, payload) VALUES (?, 'seat.fresh_launched', ?)").run(rig.id, JSON.stringify({ ...event, sessionId: old.id }));

    expect(snapshotMatchesCurrentOccupants(db, rigRepo.getRig(rig.id)!, state === "older session" ? oldSnapshot : snapshot)).toBe(state === "matching");
  });

  it("does not let exited history make a legacy detached occupant ambiguous", () => {
    const { rig, n1 } = seedRig();
    const old = sessionRegistry.registerSession(n1.id, "r99-demo1-lead");
    sessionRegistry.updateStatus(old.id, "exited");
    const current = sessionRegistry.registerSession(n1.id, "r99-demo1-lead");
    sessionRegistry.markDetached(current.id);
    const snapshot = capture.captureSnapshot(rig.id, "auto-rehydrate");

    expect(snapshotMatchesCurrentOccupants(db, rigRepo.getRig(rig.id)!, snapshot)).toBe(true);
  });

  it("assembles correct SnapshotData (rig + nodes + edges + bindings)", () => {
    const { rig, n1 } = seedRig();

    const snap = capture.captureSnapshot(rig.id, "manual");

    expect(snap.data.rig.name).toBe("r01");
    expect(snap.data.nodes).toHaveLength(2);
    expect(snap.data.edges).toHaveLength(1);
    expect(snap.data.edges[0]!.kind).toBe("delegates_to");
    // n1 has binding
    const orchNode = snap.data.nodes.find((n) => n.logicalId === "orchestrator");
    expect(orchNode!.binding).not.toBeNull();
    expect(orchNode!.binding!.tmuxSession).toBe("r99-demo1-lead");
  });

  it("includes sessions with resume metadata", () => {
    const { rig, n1 } = seedRig();
    const session = sessionRegistry.registerSession(n1.id, "r99-demo1-lead");
    db.prepare(
      "UPDATE sessions SET resume_type = ?, resume_token = ?, restore_policy = ? WHERE id = ?"
    ).run("claude_name", "my-token", "resume_if_possible", session.id);

    const snap = capture.captureSnapshot(rig.id, "manual");

    expect(snap.data.sessions).toHaveLength(1);
    expect(snap.data.sessions[0]!.resumeType).toBe("claude_name");
    expect(snap.data.sessions[0]!.resumeToken).toBe("my-token");
    expect(snap.data.sessions[0]!.restorePolicy).toBe("resume_if_possible");
  });

  it("persists a versioned intended roster and explicit three-state occupant truth", () => {
    const { rig, n1, n2 } = seedRig();
    const resolved = sessionRegistry.registerSession(n1.id, "r99-demo1-lead");
    sessionRegistry.updateStatus(resolved.id, "running");
    const ambiguousA = sessionRegistry.registerSession(n2.id, "r99-worker-a");
    const ambiguousB = sessionRegistry.registerSession(n2.id, "r99-worker-b");
    sessionRegistry.updateStatus(ambiguousA.id, "running");
    sessionRegistry.updateStatus(ambiguousB.id, "running");

    const snap = capture.captureSnapshot(rig.id, "manual", { intendedNodeIds: [n1.id, n2.id] });

    expect(snap.data.topologyRoster).toEqual({
      version: 1,
      source: "operator_explicit",
      intendedNodeIds: [n1.id, n2.id],
    });
    expect(snap.data.activeOccupantsByNode?.[n1.id]).toEqual({ kind: "resolved", sessionId: resolved.id });
    expect(snap.data.activeOccupantsByNode?.[n2.id]).toEqual({
      kind: "ambiguous",
      candidateIds: [ambiguousA.id, ambiguousB.id],
    });
  });

  it("uses the latest durable materialized topology roster instead of all historical nodes", () => {
    const { rig, n1, n2 } = seedRig();
    eventBus.emit({
      type: "topology.roster_recorded",
      rigId: rig.id,
      intendedNodeIds: [n1.id],
      source: "materialized_topology",
    });

    const snap = capture.captureSnapshot(rig.id, "manual");

    expect(snap.data.nodes.map((node) => node.id)).toContain(n2.id);
    expect(snap.data.topologyRoster).toEqual({
      version: 1,
      source: "materialized_topology",
      intendedNodeIds: [n1.id],
    });
  });

  it("refuses snapshot capture when the latest authoritative roster event is malformed", () => {
    const { rig } = seedRig();
    db.prepare("INSERT INTO events (rig_id, type, payload) VALUES (?, ?, ?)")
      .run(rig.id, "topology.roster_recorded", JSON.stringify({ intendedNodeIds: "not-an-array" }));

    expect(() => capture.captureSnapshot(rig.id, "manual")).toThrow(/malformed authoritative topology roster/);
    expect(snapshotRepo.listSnapshots(rig.id)).toHaveLength(0);
  });

  it("includes checkpoints as map (latest per node)", () => {
    const { rig, n1 } = seedRig();
    checkpointStore.createCheckpoint(n1.id, { summary: "old checkpoint", keyArtifacts: [] });
    checkpointStore.createCheckpoint(n1.id, { summary: "latest checkpoint", keyArtifacts: ["file.ts"] });

    const snap = capture.captureSnapshot(rig.id, "manual");

    expect(snap.data.checkpoints[n1.id]).not.toBeNull();
    expect(snap.data.checkpoints[n1.id]!.summary).toBe("latest checkpoint");
  });

  it("node with no checkpoint -> null in checkpoints map", () => {
    const { rig, n1, n2 } = seedRig();
    checkpointStore.createCheckpoint(n1.id, { summary: "has checkpoint", keyArtifacts: [] });
    // n2 has no checkpoint

    const snap = capture.captureSnapshot(rig.id, "manual");

    expect(snap.data.checkpoints[n1.id]).not.toBeNull();
    expect(snap.data.checkpoints[n2.id]).toBeNull();
  });

  it("persists via SnapshotRepository (retrievable by id)", () => {
    const { rig } = seedRig();

    const snap = capture.captureSnapshot(rig.id, "manual");

    const fetched = snapshotRepo.getSnapshot(snap.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(snap.id);
    expect(fetched!.data.rig.name).toBe("r01");
  });

  it("emits snapshot.created with exact payload (persisted + subscriber)", () => {
    const { rig } = seedRig();
    const notifications: PersistedEvent[] = [];
    eventBus.subscribe((e) => notifications.push(e));

    const snap = capture.captureSnapshot(rig.id, "manual");

    // Subscriber received event
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.type).toBe("snapshot.created");
    if (notifications[0]!.type === "snapshot.created") {
      expect(notifications[0]!.rigId).toBe(rig.id);
      expect(notifications[0]!.snapshotId).toBe(snap.id);
      expect(notifications[0]!.kind).toBe("manual");
    }

    // Event persisted in DB
    const events = db
      .prepare("SELECT type, payload FROM events WHERE type = 'snapshot.created'")
      .all() as { type: string; payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.rigId).toBe(rig.id);
    expect(payload.snapshotId).toBe(snap.id);
    expect(payload.kind).toBe("manual");
  });

  it("empty rig (no nodes) -> valid snapshot with empty collections", () => {
    const rig = rigRepo.createRig("r02");

    const snap = capture.captureSnapshot(rig.id, "manual");

    expect(snap.data.rig.name).toBe("r02");
    expect(snap.data.nodes).toEqual([]);
    expect(snap.data.edges).toEqual([]);
    expect(snap.data.sessions).toEqual([]);
    expect(snap.data.checkpoints).toEqual({});
  });

  it("nonexistent rig -> throws RigNotFoundError specifically", async () => {
    const { RigNotFoundError } = await import("../src/domain/errors.js");
    let caught: unknown;
    try {
      capture.captureSnapshot("nonexistent", "manual");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RigNotFoundError);
  });

  it("constructor throws on mismatched db handles", () => {
    const otherDb = setupDb();
    const otherRepo = new RigRepository(otherDb);

    expect(() =>
      new SnapshotCapture({
        db,
        rigRepo: otherRepo,
        sessionRegistry,
        eventBus,
        snapshotRepo,
        checkpointStore,
      })
    ).toThrow(/same db handle/);

    otherDb.close();
  });

  it("atomic: sabotaged event insert -> no snapshot row remains (rollback)", () => {
    const { rig } = seedRig();

    // Sabotage events table so persistWithinTransaction fails
    db.exec("DROP TABLE events");
    db.exec(
      "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, rig_id TEXT, node_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), CONSTRAINT force_fail CHECK(length(type) < 1))"
    );

    expect(() => capture.captureSnapshot(rig.id, "manual")).toThrow();

    // No snapshot row should exist (rolled back)
    const snaps = db.prepare("SELECT * FROM snapshots").all();
    expect(snaps).toHaveLength(0);

    // No event row either
    const events = db.prepare("SELECT * FROM events").all();
    expect(events).toHaveLength(0);
  });
});
