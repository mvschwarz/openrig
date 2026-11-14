import type { Migration } from "../migrate.js";

/** Persist the pod selected when a workflow starts, alongside its bound rig. */
export const workflowBoundPodSchema: Migration = {
  name: "170_workflow_bound_pod.sql",
  sql: `ALTER TABLE workflow_instances ADD COLUMN bound_pod TEXT;`,
};
