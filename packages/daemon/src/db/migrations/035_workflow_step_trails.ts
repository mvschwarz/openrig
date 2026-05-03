import type { Migration } from "../migrate.js";

/**
 * Workflow step trails (PL-004 Phase D; append-only history).
 *
 * Per PRD § L4 Workflow Runtime: every workflow step transition records
 * a trail entry. Append-only: writers only INSERT. UPDATE/DELETE are
 * not exposed by WorkflowStepTrailLog API; direct SQL would succeed
 * (SQLite has no view/role layer) but is a contract violation enforced
 * at the domain-layer API boundary.
 *
 * Columns:
 *   - trail_id (ULID PK)
 *   - instance_id (FK to workflow_instances)
 *   - step_id (from spec; e.g., "produce", "review-convergence")
 *   - step_role (from spec; e.g., "producer", "orchestrator")
 *   - closed_at (ISO timestamp of the closure/transition)
 *   - closure_reason (enum: "handoff", "waiting", "done", "failed")
 *   - closure_evidence_json (operator-supplied evidence + system-derived
 *     audit context; JSON-encoded)
 *   - actor_session (the session that closed the packet — owner-as-author)
 *   - next_qitem_id (FK to queue_items; null on terminal closure)
 *   - prior_qitem_id (the closed packet; FK to queue_items)
 *
 * Indexes:
 *   - (instance_id, closed_at DESC) — fast "trail for one workflow instance"
 *   - (closed_at DESC) — global recent activity
 */
export const workflowStepTrailsSchema: Migration = {
  name: "035_workflow_step_trails.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS workflow_step_trails (
      trail_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL REFERENCES workflow_instances(instance_id),
      step_id TEXT NOT NULL,
      step_role TEXT NOT NULL,
      closed_at TEXT NOT NULL,
      closure_reason TEXT NOT NULL,
      closure_evidence_json TEXT,
      actor_session TEXT NOT NULL,
      next_qitem_id TEXT REFERENCES queue_items(qitem_id),
      prior_qitem_id TEXT REFERENCES queue_items(qitem_id)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_step_trails_instance_recent
      ON workflow_step_trails(instance_id, closed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workflow_step_trails_recent
      ON workflow_step_trails(closed_at DESC);
  `,
};
