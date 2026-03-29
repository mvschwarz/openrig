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

function setupDb(): Database.Database {
  const db = createDb();
  migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema, checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema, agentspecRebootSchema, startupContextSchema]);
  return db;
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
