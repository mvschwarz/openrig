import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.3.19 — seat liveness PID/identity verdicts (no false-running).
 *
 * A durable, per-node identity verdict reconciling the current tmux pane's
 * PID/command with the registered managed seat. This is the persisted backing
 * store for the THIRD liveness axis (orthogonal to slice-15's `terminalActive`
 * and `hasAssignedWork`): does the process in the seat's registered pane still
 * match the seat we are reporting `running`/`active`?
 *
 * The verdict is written by the periodic SeatIdentityReconciler (mirrors the
 * SeatActivityService poll cadence) and read cheaply at projection time by
 * node-inventory. Persisting the verdict (rather than computing it read-time,
 * or holding it only in transient in-memory state) keeps `getNodeInventory`
 * synchronous + cheap and makes the durable liveness truth explicit, per the
 * dev-guard plan-review caveat.
 *
 * Columns:
 * - `node_id` (PK) — the managed node; stable across session churn.
 * - `verdict` — verified | mismatch | pane_missing | tmux_unavailable.
 *   Only `mismatch` and `pane_missing` down-rank a `running` projection;
 *   `verified` and `tmux_unavailable` (a transient/unknown observation) leave
 *   the projection unchanged, and an ABSENT row (never polled) also leaves it
 *   unchanged (fail-open on unknown — never flip a live fleet non-green on a
 *   missing observation).
 * - `evidence_source` — pane_process | tmux_session (which axis produced it).
 * - `reason` — process_identity_mismatch | pane_pid_gone | session_missing |
 *   tmux_unavailable. Mirrors the AgentActivity evidence vocabulary so
 *   consumers stay uniform.
 * - `registered_pane` / `observed_pid` / `observed_command` / `matched_layer`
 *   — the evidence payload (cf. FingerprintEvidence).
 * - `session_name` — the session the verdict was computed against.
 * - `observed_at` — ISO timestamp of the observation.
 *
 * No FK to `nodes`: stale rows for a deleted node are harmless (node-inventory
 * only reads verdicts for nodes it is already projecting) and the reconciler
 * prunes rows for no-longer-running nodes each poll. Next free number after
 * 045_resume_verification.ts.
 */
export const seatIdentityVerdictsSchema: Migration = {
  name: "046_seat_identity_verdicts.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS seat_identity_verdicts (
      node_id TEXT PRIMARY KEY,
      verdict TEXT NOT NULL,
      evidence_source TEXT,
      reason TEXT,
      registered_pane TEXT,
      observed_pid INTEGER,
      observed_command TEXT,
      matched_layer INTEGER,
      session_name TEXT,
      observed_at TEXT NOT NULL
    );
  `,
};
