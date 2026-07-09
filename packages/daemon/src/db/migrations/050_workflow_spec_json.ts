import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.6.WF1 FR-6/FR-9 (source discovery during build) —
 * workflow_specs.spec_json column.
 *
 * At ac75777a the cache stored only roles_json + steps_json (+ scalar
 * columns), so `getByNameVersion` — the path the PROJECTOR resolves
 * specs through at every project() — rebuilt a spec with
 * `loop_guards`, `invariants`, `closure`, and `entry` silently DROPPED
 * (rowToWorkflowSpec's column-only branch). readThrough compensated
 * for VALIDATION by overriding with the freshly file-parsed spec, but
 * projection-time enforcement (FR-6 max_hops) could never see the
 * declared guard. This column stores the FULL parsed spec at cache
 * time so the runtime enforces exactly what the author declared, even
 * after the source file moves or disappears (the cache's own survival
 * contract).
 *
 * NULLABLE: legacy rows fall back to the column-only reconstruction
 * (honest degradation) and self-heal on their next readThrough.
 */
export const workflowSpecJsonSchema: Migration = {
  name: "050_workflow_spec_json.sql",
  sql: `
    ALTER TABLE workflow_specs ADD COLUMN spec_json TEXT;
  `,
};
