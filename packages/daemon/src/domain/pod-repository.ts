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
  createPod(rigId: string, label: string, opts?: PodOptions): Pod {
    const id = ulid();
    this.db
      .prepare(
        "INSERT INTO pods (id, rig_id, label, summary, continuity_policy_json) VALUES (?, ?, ?, ?, ?)"
      )
      .run(id, rigId, label, opts?.summary ?? null, opts?.continuityPolicyJson ?? null);

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

  private rowToPod(row: PodRow): Pod {
    return {
      id: row.id,
      rigId: row.rig_id,
      label: row.label,
      summary: row.summary,
      continuityPolicyJson: row.continuity_policy_json,
      createdAt: row.created_at,
    };
  }
}
