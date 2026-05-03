import type { Migration } from "../migrate.js";

/**
 * Watchdog jobs (PL-004 Phase C; daemon-native Watchdog supervision tree).
 *
 * Per PRD § Watchdog + slice IMPL § Write Set: SQLite-canonical watchdog
 * jobs that join the daemon supervision tree. Three policy enum values
 * SHIPPED at Phase C v1: periodic-reminder, artifact-pool-ready,
 * edge-artifact-required. The fourth POC policy (workflow-keepalive)
 * ships in Phase D paired with workflow_instances; daemon registration
 * MUST reject it with a structured deferred-to-phase-d error.
 *
 * State enum:
 *   active   - scheduler is evaluating this job on its interval
 *   stopped  - operator stopped the job; scheduler skips it
 *   terminal - policy declared the job complete (e.g., workflow finished)
 *
 * Cadence columns mirror POC engine semantics:
 *   - interval_seconds is the legacy / fallback cadence.
 *   - scan_interval_seconds overrides the scheduler isDue cadence
 *     (how often to run the policy at all).
 *   - active_wake_interval_seconds throttles re-delivery: when the
 *     pool stays continuously actionable, fire only every Nth scan.
 *
 * Active-wake state (R1 fix; POC parity for active-wake throttle):
 *   - actionable: 1 iff the most recent scan returned action=send.
 *     Used to detect newly-actionable transitions (no throttle on
 *     transition; throttle on continued actionable state).
 *   - last_actionable_at: first attempt time during the current
 *     actionable window. Cleared when the policy returns skip.
 *
 * spec_yaml preserves the original operator-supplied YAML for audit.
 */
export const watchdogJobsSchema: Migration = {
  name: "031_watchdog_jobs.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS watchdog_jobs (
      job_id TEXT PRIMARY KEY,
      policy TEXT NOT NULL,
      spec_yaml TEXT NOT NULL,
      target_session TEXT NOT NULL,
      interval_seconds INTEGER NOT NULL,
      active_wake_interval_seconds INTEGER,
      scan_interval_seconds INTEGER,
      last_evaluation_at TEXT,
      last_fire_at TEXT,
      actionable INTEGER NOT NULL DEFAULT 0,
      last_actionable_at TEXT,
      state TEXT NOT NULL DEFAULT 'active',
      registered_by_session TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      terminal_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_watchdog_jobs_state ON watchdog_jobs(state);
    CREATE INDEX IF NOT EXISTS idx_watchdog_jobs_policy ON watchdog_jobs(policy);
    CREATE INDEX IF NOT EXISTS idx_watchdog_jobs_target_session ON watchdog_jobs(target_session);
    CREATE INDEX IF NOT EXISTS idx_watchdog_jobs_active_next_eval
      ON watchdog_jobs(last_evaluation_at) WHERE state = 'active';
  `,
};
