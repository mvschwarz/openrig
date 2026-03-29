import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { Checkpoint } from "./types.js";

interface CreateCheckpointData {
  summary: string;
  currentTask?: string | null;
  nextStep?: string | null;
  blockedOn?: string | null;
  keyArtifacts?: string[];
  confidence?: string | null;
  podId?: string | null;
  continuitySource?: string | null;
  continuityArtifactsJson?: string | null;
}

export class CheckpointStore {
  readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  createCheckpoint(nodeId: string, data: CreateCheckpointData): Checkpoint {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO checkpoints (id, node_id, summary, current_task, next_step, blocked_on, key_artifacts, confidence, pod_id, continuity_source, continuity_artifacts_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        nodeId,
        data.summary,
        data.currentTask ?? null,
        data.nextStep ?? null,
        data.blockedOn ?? null,
        JSON.stringify(data.keyArtifacts ?? []),
        data.confidence ?? null,
        data.podId ?? null,
        data.continuitySource ?? null,
        data.continuityArtifactsJson ?? null,
      );

    return this.rowToCheckpoint(
      this.db.prepare("SELECT * FROM checkpoints WHERE id = ?").get(id) as CheckpointRow
    );
  }

  getLatestCheckpoint(nodeId: string): Checkpoint | null {
    const row = this.db
      .prepare(
        "SELECT * FROM checkpoints WHERE node_id = ? ORDER BY created_at DESC LIMIT 1"
      )
      .get(nodeId) as CheckpointRow | undefined;
    return row ? this.rowToCheckpoint(row) : null;
  }

  getCheckpointsForNode(nodeId: string): Checkpoint[] {
    const rows = this.db
      .prepare("SELECT * FROM checkpoints WHERE node_id = ? ORDER BY created_at")
      .all(nodeId) as CheckpointRow[];
    return rows.map((r) => this.rowToCheckpoint(r));
  }

  getCheckpointsForRig(rigId: string): Record<string, Checkpoint | null> {
    // Get all nodes for this rig
    const nodes = this.db
      .prepare("SELECT id FROM nodes WHERE rig_id = ?")
      .all(rigId) as { id: string }[];

    const result: Record<string, Checkpoint | null> = {};

    for (const node of nodes) {
      result[node.id] = this.getLatestCheckpoint(node.id);
    }

    return result;
  }

  private rowToCheckpoint(row: CheckpointRow): Checkpoint {
    return {
      id: row.id,
      nodeId: row.node_id,
      summary: row.summary,
      currentTask: row.current_task,
      nextStep: row.next_step,
      blockedOn: row.blocked_on,
      keyArtifacts: row.key_artifacts ? JSON.parse(row.key_artifacts) as string[] : [],
      confidence: row.confidence,
      podId: row.pod_id ?? null,
      continuitySource: row.continuity_source ?? null,
      continuityArtifactsJson: row.continuity_artifacts_json ?? null,
      createdAt: row.created_at,
    };
  }
}

interface CheckpointRow {
  id: string;
  node_id: string;
  summary: string;
  current_task: string | null;
  next_step: string | null;
  blocked_on: string | null;
  key_artifacts: string | null;
  confidence: string | null;
  pod_id: string | null;
  continuity_source: string | null;
  continuity_artifacts_json: string | null;
  created_at: string;
}
