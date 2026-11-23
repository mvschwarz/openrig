import type { Migration } from "../migrate.js";

/** Optional display title belongs to the run, not its reusable workflow spec. */
export const workflowRunTitleSchema: Migration = {
  name: "194_workflow_run_title.sql",
  sql: `ALTER TABLE workflow_instances ADD COLUMN run_title TEXT;`,
};
