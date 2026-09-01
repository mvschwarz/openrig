import type { Migration } from "../migrate.js";

/**
 * OPR.0.5.8.1 S2 — one overwritten value per job: the gated CONDITION the
 * idle-gate last fired for.
 *
 * The idle-gate wake repeated on a timer rather than on a change, because its
 * only cooldown was the engine's active-wake window — and every skip clears
 * `actionable`, so a moment of seat busyness bypassed that window entirely.
 * Remembering what was last fired for lets the policy fire once per material
 * state of the gated set instead.
 *
 * Nullable and single-valued on purpose. It is overwritten, never appended to:
 * a per-wake ledger would be the bookkeeping this repair is explicitly not
 * allowed to add. A null means "nothing fired for yet", which fires once.
 */
export const idleGateFiredConditionSchema: Migration = {
  name: "078_idle_gate_fired_condition.sql",
  sql: `
    ALTER TABLE watchdog_jobs ADD COLUMN last_fired_condition TEXT;
  `,
};
