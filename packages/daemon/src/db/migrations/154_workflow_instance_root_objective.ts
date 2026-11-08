import type { Migration } from "../migrate.js";

/**
 * #2730: the root objective a workflow instance was started with, which `rig workflow instantiate` and `run` require.
 * Before this it lived only in the entry packet's body. Nullable: older instances read it as not recorded.
 */
export const workflowInstanceRootObjectiveSchema: Migration = {
  name: "154_workflow_instance_root_objective.sql",
  sql: `
    ALTER TABLE workflow_instances ADD COLUMN root_objective TEXT;
  `,
};
