// PL-004 Phase D: workflow step trail log (append-only).
//
// Owns inserts into workflow_step_trails. Append-only at the API
// surface: only `record()` is exposed. UPDATE/DELETE/remove are not
// methods — direct SQL could mutate but is a contract violation
// enforced at this domain boundary (per PRD § L4 Workflow Runtime).
//
// Pattern mirrors Phase C's WatchdogHistoryLog and Phase A's
// QueueTransitionLog.

import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { WorkflowExitKind, WorkflowStepTrailEntry } from "./workflow-types.js";

export interface WorkflowStepTrailRecordInput {
  instanceId: string;
  stepId: string;
  stepRole: string;
  closedAt: string;
  closureReason: WorkflowExitKind;
  closureEvidence?: Record<string, unknown> | null;
  actorSession: string;
  /** null for terminal closures (`done`, `failed`, `waiting`). */
  nextQitemId?: string | null;
  priorQitemId: string;
}

interface TrailRow {
  trail_id: string;
  instance_id: string;
  step_id: string;
  step_role: string;
  closed_at: string;
  closure_reason: string;
  closure_evidence_json: string | null;
  actor_session: string;
  next_qitem_id: string | null;
  prior_qitem_id: string;
}

export class WorkflowStepTrailLog {
  constructor(private readonly db: Database.Database) {}

  /**
   * Append a step trail entry. Returns the persisted entry. Designed
   * to compose inside an outer caller-managed transaction (used by
   * workflow-projector for the transactional-scribe contract).
   */
  record(input: WorkflowStepTrailRecordInput): WorkflowStepTrailEntry {
    const trailId = ulid();
    this.db
      .prepare(
        `INSERT INTO workflow_step_trails (
           trail_id, instance_id, step_id, step_role, closed_at,
           closure_reason, closure_evidence_json, actor_session,
           next_qitem_id, prior_qitem_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trailId,
        input.instanceId,
        input.stepId,
        input.stepRole,
        input.closedAt,
        input.closureReason,
        input.closureEvidence ? JSON.stringify(input.closureEvidence) : null,
        input.actorSession,
        input.nextQitemId ?? null,
        input.priorQitemId,
      );
    return {
      trailId,
      instanceId: input.instanceId,
      stepId: input.stepId,
      stepRole: input.stepRole,
      closedAt: input.closedAt,
      closureReason: input.closureReason,
      closureEvidence: input.closureEvidence ?? null,
      actorSession: input.actorSession,
      nextQitemId: input.nextQitemId ?? null,
      priorQitemId: input.priorQitemId,
    };
  }

  listForInstance(instanceId: string, limit = 50): WorkflowStepTrailEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM workflow_step_trails WHERE instance_id = ?
         ORDER BY closed_at DESC, rowid DESC LIMIT ?`,
      )
      .all(instanceId, limit) as TrailRow[];
    return rows.map(rowToEntry);
  }

  countForInstance(instanceId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM workflow_step_trails WHERE instance_id = ?`)
      .get(instanceId) as { n: number };
    return row.n;
  }
}

function rowToEntry(row: TrailRow): WorkflowStepTrailEntry {
  return {
    trailId: row.trail_id,
    instanceId: row.instance_id,
    stepId: row.step_id,
    stepRole: row.step_role,
    closedAt: row.closed_at,
    closureReason: row.closure_reason as WorkflowExitKind,
    closureEvidence: row.closure_evidence_json
      ? (JSON.parse(row.closure_evidence_json) as Record<string, unknown>)
      : null,
    actorSession: row.actor_session,
    nextQitemId: row.next_qitem_id,
    priorQitemId: row.prior_qitem_id,
  };
}
