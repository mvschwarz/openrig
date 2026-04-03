import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { Pod } from "./types.js";

interface PodOptions {
  summary?: string;
  continuityPolicyJson?: string;
}

interface PodRow {
  id: string;
  rig_id: string;
  namespace: string;
  label: string;
  summary: string | null;
  continuity_policy_json: string | null;
  created_at: string;
}

/**
 * CRUD repository for pods (bounded context domains within a rig).
 * @param db - shared database handle
 */
export class PodRepository {
  readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Create a pod within a rig.
   * @param rigId - parent rig id
   * @param label - human-readable pod label
   * @param opts - optional summary and continuity policy JSON
   * @returns the created Pod
   */
  createPod(rigId: string, namespace: string, label: string, opts?: PodOptions): Pod {
    const id = ulid();
    this.db
      .prepare(
        "INSERT INTO pods (id, rig_id, namespace, label, summary, continuity_policy_json) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(id, rigId, namespace, label, opts?.summary ?? null, opts?.continuityPolicyJson ?? null);

    return this.rowToPod(
      this.db.prepare("SELECT * FROM pods WHERE id = ?").get(id) as PodRow
    );
  }

  /**
   * Get a pod by id.
   * @param podId - pod id
   * @returns Pod or null if not found
   */
  getPod(podId: string): Pod | null {
    const row = this.db.prepare("SELECT * FROM pods WHERE id = ?").get(podId) as PodRow | undefined;
    return row ? this.rowToPod(row) : null;
  }

  /**
   * Get all pods for a rig.
   * @param rigId - rig id
   * @returns array of Pods ordered by creation time
   */
  getPodsForRig(rigId: string): Pod[] {
    const rows = this.db
      .prepare("SELECT * FROM pods WHERE rig_id = ? ORDER BY created_at")
      .all(rigId) as PodRow[];
    return rows.map((r) => this.rowToPod(r));
  }

  /**
   * Delete a pod by id.
   * Nodes with this pod_id will have pod_id set to NULL (ON DELETE SET NULL).
   * @param podId - pod id
   */
  deletePod(podId: string): void {
    this.db.prepare("DELETE FROM pods WHERE id = ?").run(podId);
  }

  // -- Continuity state operations --

  getContinuityStatesForRig(rigId: string): import("./types.js").ContinuityState[] {
    const podIds = this.db.prepare("SELECT id FROM pods WHERE rig_id = ?").all(rigId) as { id: string }[];
    if (podIds.length === 0) return [];
    const rows = this.db.prepare(
      `SELECT * FROM continuity_state WHERE pod_id IN (${podIds.map(() => "?").join(",")})`
    ).all(...podIds.map((p) => p.id)) as Array<{ pod_id: string; node_id: string; status: string; artifacts_json: string | null; last_sync_at: string | null; updated_at: string }>;
    return rows.map((r) => ({
      podId: r.pod_id,
      nodeId: r.node_id,
      status: r.status as "healthy" | "degraded" | "restoring",
      artifactsJson: r.artifacts_json,
      lastSyncAt: r.last_sync_at,
      updatedAt: r.updated_at,
    }));
  }

  updateContinuityState(podId: string, nodeId: string, status: "healthy" | "degraded" | "restoring", artifactsJson?: string): void {
    this.db.prepare(
      `INSERT INTO continuity_state (pod_id, node_id, status, artifacts_json, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(pod_id, node_id) DO UPDATE SET status = ?, artifacts_json = ?, updated_at = datetime('now')`
    ).run(podId, nodeId, status, artifactsJson ?? null, status, artifactsJson ?? null);
  }

  private rowToPod(row: PodRow): Pod {
    return {
      id: row.id,
      rigId: row.rig_id,
      namespace: row.namespace,
      label: row.label,
      summary: row.summary,
      continuityPolicyJson: row.continuity_policy_json,
      createdAt: row.created_at,
    };
  }
}
