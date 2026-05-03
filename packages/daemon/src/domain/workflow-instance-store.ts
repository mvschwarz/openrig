// PL-004 Phase D: workflow instance store.
//
// Owns CRUD on workflow_instances. Frontier tracking uses
// current_frontier_json (serialized JSON array of qitem_ids). Survives
// daemon restart without filesystem reconciliation: list/getById query
// SQLite directly.

import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type {
  WorkflowInstance,
  WorkflowInstanceStatus,
} from "./workflow-types.js";

interface InstanceRow {
  instance_id: string;
  workflow_name: string;
  workflow_version: string;
  created_by_session: string;
  created_at: string;
  status: string;
  current_frontier_json: string;
  hop_count: number;
  fallback_synthesis: string | null;
  last_continuation_decision_json: string | null;
  completed_at: string | null;
}

export interface CreateWorkflowInstanceInput {
  workflowName: string;
  workflowVersion: string;
  createdBySession: string;
  initialFrontier?: string[];
}

export class WorkflowInstanceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WorkflowInstanceError";
  }
}

export class WorkflowInstanceStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(input: CreateWorkflowInstanceInput): WorkflowInstance {
    const instanceId = ulid();
    const createdAt = this.now().toISOString();
    const frontier = input.initialFrontier ?? [];
    this.db
      .prepare(
        `INSERT INTO workflow_instances (
           instance_id, workflow_name, workflow_version, created_by_session,
           created_at, status, current_frontier_json, hop_count
         ) VALUES (?, ?, ?, ?, ?, 'active', ?, 0)`,
      )
      .run(
        instanceId,
        input.workflowName,
        input.workflowVersion,
        input.createdBySession,
        createdAt,
        JSON.stringify(frontier),
      );
    return this.getByIdOrThrow(instanceId);
  }

  getById(instanceId: string): WorkflowInstance | null {
    const row = this.db
      .prepare(`SELECT * FROM workflow_instances WHERE instance_id = ?`)
      .get(instanceId) as InstanceRow | undefined;
    return row ? rowToInstance(row) : null;
  }

  getByIdOrThrow(instanceId: string): WorkflowInstance {
    const inst = this.getById(instanceId);
    if (!inst) {
      throw new WorkflowInstanceError(
        "instance_not_found",
        `workflow instance ${instanceId} not found`,
        { instanceId },
      );
    }
    return inst;
  }

  listByStatus(status: WorkflowInstanceStatus): WorkflowInstance[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM workflow_instances WHERE status = ? ORDER BY created_at ASC`,
      )
      .all(status) as InstanceRow[];
    return rows.map(rowToInstance);
  }

  listAll(): WorkflowInstance[] {
    const rows = this.db
      .prepare(`SELECT * FROM workflow_instances ORDER BY created_at ASC`)
      .all() as InstanceRow[];
    return rows.map(rowToInstance);
  }

  /**
   * Update frontier + status atomically. Caller is responsible for
   * wrapping in a transaction when this needs to compose with other
   * mutations (e.g., workflow-projector folds this into the
   * close + create + frontier-update transaction).
   */
  updateFrontier(
    instanceId: string,
    nextFrontier: string[],
    nextStatus: WorkflowInstanceStatus,
    opts: {
      bumpHopCount?: boolean;
      lastContinuationDecision?: Record<string, unknown> | null;
      fallbackSynthesis?: string | null;
      completedAt?: string | null;
    } = {},
  ): void {
    const setHop = opts.bumpHopCount ? "hop_count = hop_count + 1, " : "";
    this.db
      .prepare(
        `UPDATE workflow_instances SET
           ${setHop}status = ?, current_frontier_json = ?,
           last_continuation_decision_json = COALESCE(?, last_continuation_decision_json),
           fallback_synthesis = COALESCE(?, fallback_synthesis),
           completed_at = COALESCE(?, completed_at)
         WHERE instance_id = ?`,
      )
      .run(
        nextStatus,
        JSON.stringify(nextFrontier),
        opts.lastContinuationDecision ? JSON.stringify(opts.lastContinuationDecision) : null,
        opts.fallbackSynthesis ?? null,
        opts.completedAt ?? null,
        instanceId,
      );
  }
}

function rowToInstance(row: InstanceRow): WorkflowInstance {
  return {
    instanceId: row.instance_id,
    workflowName: row.workflow_name,
    workflowVersion: row.workflow_version,
    createdBySession: row.created_by_session,
    createdAt: row.created_at,
    status: row.status as WorkflowInstanceStatus,
    currentFrontier: JSON.parse(row.current_frontier_json) as string[],
    hopCount: row.hop_count,
    fallbackSynthesis: row.fallback_synthesis,
    lastContinuationDecision: row.last_continuation_decision_json
      ? (JSON.parse(row.last_continuation_decision_json) as Record<string, unknown>)
      : null,
    completedAt: row.completed_at,
  };
}
