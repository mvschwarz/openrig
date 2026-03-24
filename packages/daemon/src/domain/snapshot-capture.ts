import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { SnapshotRepository } from "./snapshot-repository.js";
import type { PersistedEvent } from "./types.js";
import type { CheckpointStore } from "./checkpoint-store.js";
import type { Snapshot, SnapshotData } from "./types.js";

interface SnapshotCaptureDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  snapshotRepo: SnapshotRepository;
  checkpointStore: CheckpointStore;
}

export class SnapshotCapture {
  private db: Database.Database;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private eventBus: EventBus;
  private snapshotRepo: SnapshotRepository;
  private checkpointStore: CheckpointStore;

  constructor(deps: SnapshotCaptureDeps) {
    if (deps.db !== deps.rigRepo.db) {
      throw new Error("SnapshotCapture: rigRepo must share the same db handle");
    }
    if (deps.db !== deps.sessionRegistry.db) {
      throw new Error("SnapshotCapture: sessionRegistry must share the same db handle");
    }
    if (deps.db !== deps.eventBus.db) {
      throw new Error("SnapshotCapture: eventBus must share the same db handle");
    }
    if (deps.db !== deps.snapshotRepo.db) {
      throw new Error("SnapshotCapture: snapshotRepo must share the same db handle");
    }
    if (deps.db !== deps.checkpointStore.db) {
      throw new Error("SnapshotCapture: checkpointStore must share the same db handle");
    }

    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.snapshotRepo = deps.snapshotRepo;
    this.checkpointStore = deps.checkpointStore;
  }

  captureSnapshot(rigId: string, kind: string): Snapshot {
    // 1. Get rig with nodes, edges, bindings
    const rig = this.rigRepo.getRig(rigId);
    if (!rig) {
      throw new Error(`Rig ${rigId} not found`);
    }

    // 2. Get sessions with resume metadata
    const sessions = this.sessionRegistry.getSessionsForRig(rigId);

    // 3. Get checkpoints as map (latest per node)
    const checkpoints = this.checkpointStore.getCheckpointsForRig(rigId);

    // 4. Assemble SnapshotData
    const data: SnapshotData = {
      rig: rig.rig,
      nodes: rig.nodes,
      edges: rig.edges,
      sessions,
      checkpoints,
    };

    // 5. Atomic: persist snapshot + event in one transaction
    const txn = this.db.transaction(() => {
      const snapshot = this.snapshotRepo.createSnapshot(rigId, kind, data);
      const persistedEvent = this.eventBus.persistWithinTransaction({
        type: "snapshot.created",
        rigId,
        snapshotId: snapshot.id,
        kind,
      });
      return { snapshot, persistedEvent };
    });

    const { snapshot, persistedEvent } = txn();

    // 6. Notify subscribers after commit (best-effort)
    this.eventBus.notifySubscribers(persistedEvent);

    return snapshot;
  }
}
