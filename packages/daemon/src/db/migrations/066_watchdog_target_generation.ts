import type { Migration } from "../migrate.js";

/**
 * GHOST-STAGE (i-c) — opt-in TARGET-generation stamp on watchdog_jobs.
 *
 * The registration-side ghost (a RETIRED registerer's job firing post-handover) is already closed by
 * migration 063 + `dropArmedByRegisteringGeneration`. This column is the FIRE-TIME complement: a
 * GENERATION-bound wake (opt-in) records the occupant-generation it is meant FOR, so the wake-issuer
 * (WatchdogPolicyEngine) can refuse to fire it at a target that has since been handed over to a
 * DIFFERENT live generation (the P12 `occupant_tenures` gen-check at deliver time).
 *
 * NULLABLE, no default: a NULL `target_generation_uuid` = ROLE-bound (fire at whoever occupies the
 * seat NAME — the legitimate common case, fires UNCHANGED). Only a non-NULL stamp opts a job into the
 * fire-time gen-gate. Additive ALTER; the repository's defensive column-detect keeps pre-066 fixtures
 * degrading cleanly (writers leave it NULL, the gate no-ops → deliver).
 */
export const watchdogTargetGenerationSchema: Migration = {
  name: "066_watchdog_target_generation.sql",
  sql: `
    ALTER TABLE watchdog_jobs ADD COLUMN target_generation_uuid TEXT;
  `,
};
