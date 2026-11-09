import type { Migration } from "../migrate.js";

/**
 * #2607: the spec a workflow instance started with (JSON) and the file it came from. The spec cache keeps one row per
 * workflow id and version, so another file with the same id and version replaces that row; an instance whose own file
 * no longer fills the row runs this copy instead. Nullable: instances from before this read the cache row as before.
 */
export const workflowInstanceSpecSchema: Migration = {
  name: "152_workflow_instance_spec.sql",
  sql: `
    ALTER TABLE workflow_instances ADD COLUMN spec_source_path TEXT;
    ALTER TABLE workflow_instances ADD COLUMN spec_json TEXT;
  `,
};
