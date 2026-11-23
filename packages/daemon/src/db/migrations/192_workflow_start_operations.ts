import type { Migration } from "../migrate.js";

/** The receipt commits atomically with the ordinary instance and entry packet. */
export const workflowStartOperationsSchema: Migration = {
  name: "192_workflow_start_operations.sql",
  sql: `CREATE TABLE workflow_start_operations (
    operation_key TEXT PRIMARY KEY,
    request_digest TEXT NOT NULL,
    instance_id TEXT NOT NULL REFERENCES workflow_instances(instance_id),
    entry_qitem_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    actor_session TEXT NOT NULL
  );`,
};
