import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.6.WF5 FR-4 — workflow_instances resume columns.
 *
 * `resume_count`: the recorded redrive fact (the AWS Step Functions
 * `redriveCount` shape — a first-class recorded field, never inferred
 * from the trail).
 *
 * `hops_baseline`: the LIVELOCK RAIL (arch return R1). max_hops bounds
 * each DRIVE, not the instance lifetime: the projection guard compares
 * hops accrued since the LATEST instantiate-OR-resume, so a human
 * resume sanctions exactly one more bounded window instead of
 * re-tripping instantly on the first post-resume projection. WF-1's
 * guard comment left this exact seam open ("WF-5 FR-4's resume later
 * amends the baseline").
 *
 * Additive, NOT NULL DEFAULT 0: existing instances keep the v1
 * baseline (0) and zero resumes — no backfill, byte-identical behavior
 * until the first resume.
 */
export const workflowResumeSchema: Migration = {
  name: "051_workflow_resume.sql",
  sql: `
    ALTER TABLE workflow_instances ADD COLUMN resume_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE workflow_instances ADD COLUMN hops_baseline INTEGER NOT NULL DEFAULT 0;
  `,
};
