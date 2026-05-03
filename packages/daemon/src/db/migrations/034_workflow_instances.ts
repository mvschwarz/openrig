import type { Migration } from "../migrate.js";

/**
 * Workflow instances (PL-004 Phase D; live workflow state).
 *
 * Per PRD § L4 Workflow Runtime: a workflow instance is a SQLite-canonical
 * record of a running workflow. Survives daemon restart without
 * filesystem reconciliation. The current_frontier_json column holds the
 * array of qitem_ids that are the active step packets at any given time.
 *
 * R2 fix (guard blocker 1): durable current-step binding via
 * `current_step_id`. Replaces trail-based "last_step + 1" inference,
 * which produced wrong results for reused-frontier packets (e.g.,
 * waiting → resume on same packet would skip a step). Mirrors POC
 * which extracts step_id from the current packet binding rather than
 * inferring from trail order. v1 supports a single active frontier
 * packet; multi-frontier (parallel branches) is graduation and would
 * need a packet→step map.
 *
 * Status enum (matches POC + PRD):
 *   - active: instance has at least one frontier packet in-flight
 *   - waiting: instance has a frontier packet blocked on an external gate
 *   - completed: terminal success state; current_frontier_json is []
 *   - failed: terminal failure state
 *
 * fallback_synthesis: nullable text recording the agent-judgment
 * synthesis used when peer continuity relay was not available (closed
 * but no successor identified). Optional audit context.
 *
 * hop_count: count of step transitions executed; PRD invariant
 * `loop_guards.max_hops` is checked at projection time.
 *
 * last_continuation_decision_json: optional structured record of the
 * most recent continuation/closure decision (the `handoff_decision`,
 * `wait_decision`, or `close_decision` shape from the POC). Used for
 * trace and debugging.
 *
 * Indexes:
 *   - (status, workflow_name) — fast "find active instances of workflow X"
 *   - (created_by_session, status) — fast "find my live workflows"
 */
export const workflowInstancesSchema: Migration = {
  name: "034_workflow_instances.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS workflow_instances (
      instance_id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      workflow_version TEXT NOT NULL,
      created_by_session TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      current_frontier_json TEXT NOT NULL DEFAULT '[]',
      current_step_id TEXT,
      hop_count INTEGER NOT NULL DEFAULT 0,
      fallback_synthesis TEXT,
      last_continuation_decision_json TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_instances_status_name
      ON workflow_instances(status, workflow_name);
    CREATE INDEX IF NOT EXISTS idx_workflow_instances_creator_status
      ON workflow_instances(created_by_session, status);
  `,
};
