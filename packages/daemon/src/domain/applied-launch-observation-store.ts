import type Database from "better-sqlite3";
import type { AppliedLaunchAxis, AppliedLaunchObservation, AppliedLaunchState } from "./permission-drift.js";

export interface StoredAppliedLaunchObservation extends AppliedLaunchObservation {
  generationUuid: string;
  observedAt: string;
}

interface ObservationRow {
  generation_uuid: string;
  runtime: string;
  axis: string;
  observation_state: string;
  value: string | null;
  reason: string | null;
  observed_at: string;
}

/**
 * Best-effort, generation-scoped persistence for the exact enforcing value
 * returned by a successful managed launch. Missing migrations and DB failures
 * degrade to UNKNOWN; they never turn a successful provider launch into a
 * failed launch.
 */
export class AppliedLaunchObservationStore {
  constructor(private readonly db: Database.Database) {}

  recordCurrent(nodeId: string, observation: AppliedLaunchObservation): boolean {
    try {
      const tenure = this.db.prepare(
        "SELECT generation_uuid FROM occupant_tenures WHERE node_id = ? ORDER BY generation_ordinal DESC LIMIT 1",
      ).get(nodeId) as { generation_uuid: string } | undefined;
      if (!tenure) return false;
      this.db.prepare(`
        INSERT INTO applied_launch_observations (
          generation_uuid, runtime, axis, observation_state, value, reason, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(generation_uuid) DO UPDATE SET
          runtime = excluded.runtime,
          axis = excluded.axis,
          observation_state = excluded.observation_state,
          value = excluded.value,
          reason = excluded.reason,
          observed_at = excluded.observed_at
      `).run(
        tenure.generation_uuid,
        observation.runtime,
        observation.axis,
        observation.state,
        observation.value,
        observation.reason ?? null,
      );
      return true;
    } catch {
      return false;
    }
  }

  readCurrent(nodeId: string): StoredAppliedLaunchObservation | null {
    try {
      const row = this.db.prepare(`
        SELECT o.*
          FROM (
            SELECT generation_uuid
              FROM occupant_tenures
             WHERE node_id = ?
             ORDER BY generation_ordinal DESC
             LIMIT 1
          ) current_tenure
          JOIN applied_launch_observations o
            ON o.generation_uuid = current_tenure.generation_uuid
      `).get(nodeId) as ObservationRow | undefined;
      if (!row) return null;
      return {
        generationUuid: row.generation_uuid,
        runtime: row.runtime,
        axis: row.axis as AppliedLaunchAxis,
        state: row.observation_state as AppliedLaunchState,
        value: row.value,
        ...(row.reason ? { reason: row.reason } : {}),
        observedAt: row.observed_at,
      };
    } catch {
      return null;
    }
  }
}
