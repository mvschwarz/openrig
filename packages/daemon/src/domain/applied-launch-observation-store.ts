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

  recordGeneration(generationUuid: string, observation: AppliedLaunchObservation): boolean {
    try {
      const result = this.db.prepare(`
        INSERT INTO applied_launch_observations (
          generation_uuid, runtime, axis, observation_state, value, reason, observed_at
        )
        SELECT ?, ?, ?, ?, ?, ?, datetime('now')
         WHERE NOT EXISTS (
           SELECT 1
             FROM applied_launch_observation_invalidations
            WHERE generation_uuid = ?
         )
        ON CONFLICT(generation_uuid) DO UPDATE SET
          runtime = excluded.runtime,
          axis = excluded.axis,
          observation_state = excluded.observation_state,
          value = excluded.value,
          reason = excluded.reason,
          observed_at = excluded.observed_at
      `).run(
        generationUuid,
        observation.runtime,
        observation.axis,
        observation.state,
        observation.value,
        observation.reason ?? null,
        generationUuid,
      );
      return result.changes > 0;
    } catch {
      return false;
    }
  }

  invalidateGeneration(generationUuid: string): boolean {
    try {
      return this.db.transaction(() => {
        const exists = this.db.prepare(
          "SELECT 1 FROM occupant_tenures WHERE generation_uuid = ?",
        ).get(generationUuid);
        if (!exists) return false;
        this.db.prepare(`
          INSERT OR IGNORE INTO applied_launch_observation_invalidations (generation_uuid)
          VALUES (?)
        `).run(generationUuid);
        this.db.prepare("DELETE FROM applied_launch_observations WHERE generation_uuid = ?").run(generationUuid);
        return true;
      })();
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
          LEFT JOIN applied_launch_observation_invalidations invalidated
            ON invalidated.generation_uuid = current_tenure.generation_uuid
         WHERE invalidated.generation_uuid IS NULL
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
