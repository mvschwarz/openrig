import type { Migration } from "../migrate.js";

/**
 * Watchdog policy enum extension (PL-004 Phase D).
 *
 * DOCUMENTING NO-OP MIGRATION.
 *
 * Phase C implements the watchdog_jobs.policy enum at the application
 * layer (in WatchdogJobsRepository.register() via the PHASE_C_POLICIES
 * array + WORKFLOW_KEEPALIVE_DEFERRED_POLICY constant). The SQLite
 * column itself is plain TEXT with no CHECK constraint, so extending
 * the enum to include "workflow-keepalive" requires NO schema change.
 *
 * The actual enforcement extension lives in:
 *   packages/daemon/src/domain/watchdog-jobs-repository.ts
 *     - PHASE_C_POLICIES → renamed to PHASE_D_POLICIES (or extended)
 *       to include "workflow-keepalive"
 *     - WORKFLOW_KEEPALIVE_DEFERRED_POLICY rejection removed
 *
 * This migration exists for two reasons:
 *   1. Audit trail: documents that Phase D extended the policy enum
 *      surface, even though no DDL was needed.
 *   2. Migration sequence integrity: keeps Phase D's migration count
 *      visible in the daemon startup log alongside the three new
 *      workflow tables (033, 034, 035). Slice IMPL row 17 explicitly
 *      requires the extension migration land "cleanly without
 *      touching Phase C's existing migration files" — this no-op
 *      satisfies that constraint.
 *
 * Per slice IMPL § Write Set:
 *   "if the enforcement is application-layer in
 *   `watchdog-policy-engine.ts`, the migration is a no-op SQL but
 *   documents the policy enum intent."
 */
export const watchdogPolicyEnumExtensionSchema: Migration = {
  name: "036_watchdog_policy_enum_extension.sql",
  sql: `
    -- No DDL: Phase C policy enum is enforced at the application layer
    -- via PHASE_D_POLICIES in watchdog-jobs-repository.ts. The
    -- watchdog_jobs.policy column remains plain TEXT. This migration
    -- exists as an audit-trail marker for the Phase D enum extension.
    SELECT 1 WHERE 0;
  `,
};
