import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.8.3 Seam B (Guard NOT-CLEAR at 9e94c274, finding 1): additive restart-stable
 * provenance for the RIG-level resolved permission-policy attachment. The raw rig ref
 * (migration 056) alone is not restart-complete for a RELATIVE custom policy: organic
 * claim/self-attach seats have no node provenance, structured add-member runs under a
 * DIFFERENT operation root, and restore/successor must never resolve a persisted relative
 * ref against an unrelated cwd. Columns mirror the node-level 057 set:
 *   rig_policy_origin / rig_policy_resolved_target / rig_policy_declaring_dir /
 *   rig_policy_launch_posture
 * declaring_dir = the ORIGINAL declaring RigSpec directory (the materialize rigRoot).
 * Additive only; NULLs = no rig-level policy attached.
 */
export const rigPolicyProvenanceSchema: Migration = {
  name: "058_rig_policy_provenance.sql",
  sql: `
    ALTER TABLE rigs ADD COLUMN rig_policy_origin TEXT;
    ALTER TABLE rigs ADD COLUMN rig_policy_resolved_target TEXT;
    ALTER TABLE rigs ADD COLUMN rig_policy_declaring_dir TEXT;
    ALTER TABLE rigs ADD COLUMN rig_policy_launch_posture TEXT;
  `,
};
