import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { SnapshotRepository } from "./snapshot-repository.js";
import type { PersistedEvent } from "./types.js";
import type { CheckpointStore } from "./checkpoint-store.js";
import type { Snapshot, SnapshotData } from "./types.js";
import { RigNotFoundError } from "./errors.js";

interface SnapshotCaptureDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  snapshotRepo: SnapshotRepository;
  checkpointStore: CheckpointStore;
}

export class SnapshotCapture {
  readonly db: Database.Database;
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
      throw new RigNotFoundError(rigId);
    }

    // 2. Get sessions with resume metadata
    const sessions = this.sessionRegistry.getSessionsForRig(rigId);

    // 3. Get checkpoints as map (latest per node)
    const checkpoints = this.checkpointStore.getCheckpointsForRig(rigId);

    // 4. Get pods + continuity state + startup context
    const podRows = this.db.prepare("SELECT * FROM pods WHERE rig_id = ?")
      .all(rigId) as Array<{ id: string; rig_id: string; label: string; summary: string | null; continuity_policy_json: string | null; created_at: string }>;
    const podIds = podRows.map((p) => p.id);
    const continuityRows = podIds.length > 0
      ? this.db.prepare(`SELECT * FROM continuity_state WHERE pod_id IN (${podIds.map(() => "?").join(",")})`)
          .all(...podIds) as Array<{ pod_id: string; node_id: string; status: string; artifacts_json: string | null; last_sync_at: string | null; updated_at: string }>
      : [];

    const nodeStartupContext: Record<string, import("./types.js").NodeStartupSnapshot | null> = {};
    for (const node of rig.nodes) {
      const ctx = this.db.prepare("SELECT * FROM node_startup_context WHERE node_id = ?")
        .get(node.id) as { projection_entries_json: string; resolved_files_json: string; startup_actions_json: string; runtime: string } | undefined;
      nodeStartupContext[node.id] = ctx ? {
        projectionEntries: JSON.parse(ctx.projection_entries_json),
        resolvedStartupFiles: JSON.parse(ctx.resolved_files_json),
        startupActions: JSON.parse(ctx.startup_actions_json),
        runtime: ctx.runtime,
      } : null;
    }

    // 5. Assemble SnapshotData
    const data: SnapshotData = {
      rig: rig.rig,
      nodes: rig.nodes,
      edges: rig.edges,
      sessions,
      checkpoints,
      pods: podRows.map((p) => ({ id: p.id, rigId: p.rig_id, label: p.label, summary: p.summary, continuityPolicyJson: p.continuity_policy_json, createdAt: p.created_at })),
      continuityStates: continuityRows.map((r) => ({ podId: r.pod_id, nodeId: r.node_id, status: r.status as "healthy" | "degraded" | "restoring", artifactsJson: r.artifacts_json, lastSyncAt: r.last_sync_at, updatedAt: r.updated_at })),
      nodeStartupContext,
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
