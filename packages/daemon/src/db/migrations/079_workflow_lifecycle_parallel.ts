import type { Migration } from "../migrate.js";

/**
 * S06 Waves 1-3: additive lifecycle replay identity plus packet-addressed
 * frontier and failure state.  Every new instance column is nullable so a
 * pre-lifecycle row remains byte-for-byte meaningful to the legacy reader.
 */
export const workflowLifecycleParallelSchema: Migration = {
  name: "079_workflow_lifecycle_parallel.sql",
  sql: `
    ALTER TABLE workflow_instances ADD COLUMN lifecycle_operation_key TEXT;
    ALTER TABLE workflow_instances ADD COLUMN compiled_input_digest TEXT;
    ALTER TABLE workflow_instances ADD COLUMN lifecycle_binding_json TEXT;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_instances_lifecycle_operation
      ON workflow_instances(lifecycle_operation_key)
      WHERE lifecycle_operation_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS workflow_frontier_bindings (
      instance_id TEXT NOT NULL REFERENCES workflow_instances(instance_id),
      packet_id TEXT NOT NULL REFERENCES queue_items(qitem_id),
      step_id TEXT NOT NULL,
      branch_drive INTEGER NOT NULL DEFAULT 0,
      hop_count INTEGER NOT NULL DEFAULT 0,
      hops_baseline INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY (instance_id, packet_id),
      UNIQUE (packet_id)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_frontier_bindings_instance
      ON workflow_frontier_bindings(instance_id, created_at, packet_id);

    CREATE TABLE IF NOT EXISTS workflow_failure_occurrences (
      occurrence_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL REFERENCES workflow_instances(instance_id),
      failed_packet_id TEXT NOT NULL REFERENCES queue_items(qitem_id),
      step_id TEXT NOT NULL,
      branch_drive INTEGER NOT NULL DEFAULT 0,
      hop_count INTEGER NOT NULL DEFAULT 0,
      hops_baseline INTEGER NOT NULL DEFAULT 0,
      failure_reason TEXT,
      status TEXT NOT NULL DEFAULT 'unresolved',
      redrive_packet_id TEXT REFERENCES queue_items(qitem_id),
      resume_decision TEXT,
      failed_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_failure_occurrences_instance_status
      ON workflow_failure_occurrences(instance_id, status, failed_at, occurrence_id);
  `,
};
