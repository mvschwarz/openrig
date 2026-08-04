import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.8.3 Seam B — rigs.permission_policy column.
 *
 * Adds `permission_policy TEXT` to the rigs table. Holds the rig-level
 * permission_policy REF (`builtin:<name>` or a spec-relative custom path)
 * when a rig declares one, populated by RigRepository.setRigPermissionPolicy
 * at instantiate time and read back via getRigPermissionPolicy (exporter /
 * discovery). NULL for rigs without an attached policy (= the floor).
 * Mirrors migration 038 (rigs.workspace_json).
 */
export const rigPermissionPolicySchema: Migration = {
  name: "056_rig_permission_policy.sql",
  sql: `
    ALTER TABLE rigs ADD COLUMN permission_policy TEXT;
  `,
};
