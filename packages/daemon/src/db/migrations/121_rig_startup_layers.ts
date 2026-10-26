import type { Migration } from "../migrate.js";

/**
 * rigs.startup_layers_json: the rig-level startup layers a rig was materialized with.
 *
 * Holds the spec's `culture_file` and rig `startup` block as declared, with the absolute root their paths
 * resolve against, written by RigRepository.setRigStartupLayers when a rig is created from a spec that
 * declares either. A seat added later (`rig expand`, add-member) launches from a synthetic spec that
 * carries neither, so the launch reads them back and resolves them against that stored root, exactly as
 * an original seat did. NULL = the rig declared neither, or was created before this column.
 * Mirrors migration 085 (rigs.claude_managed_block_file).
 */
export const rigStartupLayersSchema: Migration = {
  name: "121_rig_startup_layers.sql",
  sql: `
    ALTER TABLE rigs ADD COLUMN startup_layers_json TEXT;
  `,
};
