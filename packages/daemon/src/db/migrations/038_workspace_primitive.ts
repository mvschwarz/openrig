import type { Migration } from "../migrate.js";

/**
 * PL-007 Workspace Primitive v0 — rigs.workspace_json column.
 *
 * Adds `workspace_json TEXT` to the rigs table. Holds the typed
 * RigSpec.workspace block as JSON when a rig declares one. Populated by
 * RigRepository.setRigWorkspace at instantiate time. Whoami /
 * node-inventory read this column to surface workspace fields alongside
 * cwd. NULL for rigs without a workspace block.
 *
 * The companion queue_items.target_repo column ships in migration 039
 * so test fixtures that exercise rigs without queue_items (and vice
 * versa) can apply only the half they need.
 */
export const workspacePrimitiveSchema: Migration = {
  name: "038_workspace_primitive.sql",
  sql: `
    ALTER TABLE rigs ADD COLUMN workspace_json TEXT;
  `,
};
