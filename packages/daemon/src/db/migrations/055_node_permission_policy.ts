import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.8.3 Seam B — nodes.permission_policy column.
 *
 * Adds `permission_policy TEXT` to the nodes table. Holds the per-seat
 * permission_policy REF (`builtin:<name>` or a spec-relative custom path)
 * when a seat declares one, written by createMemberNode → addNode.
 * NULL when the seat attaches no policy (= the floor). Mirrors migration
 * 022 (node codex_config_profile); the repository probes for the column
 * so a seat attribute round-trips only on DBs that have the column.
 */
export const nodePermissionPolicySchema: Migration = {
  name: "055_node_permission_policy.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN permission_policy TEXT;
  `,
};
