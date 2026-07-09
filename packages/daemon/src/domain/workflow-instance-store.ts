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
  current_step_id: string | null;
  hop_count: number;
  fallback_synthesis: string | null;
  last_continuation_decision_json: string | null;
  completed_at: string | null;
  /** OPR.0.4.6.WF1 FR-5 — optimistic-concurrency version (migration
   *  049). Optional at the row layer: legacy fixtures without the
   *  migration read undefined and map to 0. */
  version?: number;
  /** OPR.0.4.6.WF5 FR-4 (migration 051) — optional at the row layer
   *  like version: legacy fixtures map to 0. */
  resume_count?: number;
  hops_baseline?: number;
  /** OPR.0.4.6.FAC1 (migration 052) — optional at the row layer like
   *  version: legacy fixtures map to null (unbound). */
  bound_rig?: string | null;
}

/** Defensive column probe (the detectQueueColumn house pattern) —
 *  older test fixtures bypass the canonical migration list, so the
 *  version column (migration 049) may be absent; the guard degrades
 *  to legacy unguarded updates there. Production always migrates. */
function detectInstanceColumn(db: Database.Database, columnName: string): boolean {
  try {
    return db
      .prepare("PRAGMA table_info(workflow_instances)")
      .all()
      .some((row) => (row as { name?: string }).name === columnName);
  } catch {
    return false;
  }
}

export interface CreateWorkflowInstanceInput {
  workflowName: string;
  workflowVersion: string;
  createdBySession: string;
  initialFrontier?: string[];
  /** R2: durable current-step binding set at instantiate time. */
  currentStepId?: string;
  /**
   * OPR.0.4.6.FAC1: the rig NAME this instance binds to (already
   * resolved by the runtime: targetRig override ?? spec.target.rig).
   * null/absent = unbound (today's behavior byte-identical).
   */
  boundRig?: string | null;
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
  private readonly hasVersionColumn: boolean;
  private readonly hasResumeColumns: boolean;
  private readonly hasBoundRigColumn: boolean;

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.hasVersionColumn = detectInstanceColumn(db, "version");
    this.hasResumeColumns = detectInstanceColumn(db, "resume_count");
    this.hasBoundRigColumn = detectInstanceColumn(db, "bound_rig");
  }

  create(input: CreateWorkflowInstanceInput): WorkflowInstance {
    const instanceId = ulid();
    const createdAt = this.now().toISOString();
    const frontier = input.initialFrontier ?? [];
    // OPR.0.4.6.FAC1: bound_rig rides the same defensive column probe
    // as version/resume (legacy fixtures without migration 052 keep the
    // legacy INSERT; production always migrates).
    const boundRigCol = this.hasBoundRigColumn ? ", bound_rig" : "";
    const boundRigVal = this.hasBoundRigColumn ? ", ?" : "";
    const params: unknown[] = [
      instanceId,
      input.workflowName,
      input.workflowVersion,
      input.createdBySession,
      createdAt,
      JSON.stringify(frontier),
      input.currentStepId ?? null,
    ];
    if (this.hasBoundRigColumn) params.push(input.boundRig ?? null);
    this.db
      .prepare(
        `INSERT INTO workflow_instances (
           instance_id, workflow_name, workflow_version, created_by_session,
           created_at, status, current_frontier_json, current_step_id, hop_count${boundRigCol}
         ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 0${boundRigVal})`,
      )
      .run(...(params as never[]));
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
      /**
       * R2: explicit next current_step_id. When provided, OVERWRITES
       * the column (including to NULL by passing the empty string for
       * "clear"). When omitted, current_step_id is preserved (the
       * frontier packet is reused, e.g., on waiting). To clear pass
       * the symbol "clear-current-step" (typed as the literal below).
       */
      currentStepId?: string | "preserve" | "clear";
      /**
       * OPR.0.4.6.WF1 FR-5 — the optimistic-concurrency guard. When
       * provided, the UPDATE is qualified `WHERE version = ?` and bumps
       * `version = version + 1`; zero rows changed throws the
       * structured `instance_version_conflict` naming expected/actual
       * (the caller's transaction rolls back whole). When omitted,
       * legacy unguarded behavior (no version read, no bump) — the
       * projector ALWAYS provides it.
       */
      expectedVersion?: number;
      /**
       * OPR.0.4.6.WF5 FR-4 — the resume stamp: sets the recorded
       * redrive count AND the livelock-rail hops baseline atomically
       * with the frontier rebind. Only resume() passes it.
       */
      resumeStamp?: { resumeCount: number; hopsBaseline: number };
    } = {},
  ): void {
    const setHop = opts.bumpHopCount ? "hop_count = hop_count + 1, " : "";
    const setResume =
      opts.resumeStamp && this.hasResumeColumns
        ? `resume_count = ${Number(opts.resumeStamp.resumeCount)}, hops_baseline = ${Number(opts.resumeStamp.hopsBaseline)}, `
        : "";
    const guardVersion = opts.expectedVersion !== undefined && this.hasVersionColumn;
    const setVersion = guardVersion ? "version = version + 1, " : "";
    const versionWhere = guardVersion ? " AND version = ?" : "";
    let currentStepClause = "";
    let currentStepValue: string | null | undefined;
    if (opts.currentStepId === "preserve" || opts.currentStepId === undefined) {
      currentStepClause = "";
      currentStepValue = undefined;
    } else if (opts.currentStepId === "clear") {
      currentStepClause = "current_step_id = NULL, ";
    } else {
      currentStepClause = "current_step_id = ?, ";
      currentStepValue = opts.currentStepId;
    }
    const sql = `UPDATE workflow_instances SET
           ${setVersion}${setHop}${setResume}${currentStepClause}status = ?, current_frontier_json = ?,
           last_continuation_decision_json = COALESCE(?, last_continuation_decision_json),
           fallback_synthesis = COALESCE(?, fallback_synthesis),
           completed_at = COALESCE(?, completed_at)
         WHERE instance_id = ?${versionWhere}`;
    const stmt = this.db.prepare(sql);
    const params: unknown[] = [];
    if (currentStepValue !== undefined) params.push(currentStepValue);
    params.push(
      nextStatus,
      JSON.stringify(nextFrontier),
      opts.lastContinuationDecision ? JSON.stringify(opts.lastContinuationDecision) : null,
      opts.fallbackSynthesis ?? null,
      opts.completedAt ?? null,
      instanceId,
    );
    if (guardVersion) params.push(opts.expectedVersion);
    const info = stmt.run(...(params as never[]));
    if (guardVersion && info.changes === 0) {
      const current = this.getById(instanceId);
      throw new WorkflowInstanceError(
        "instance_version_conflict",
        `workflow instance ${instanceId} advanced concurrently: expected version ${opts.expectedVersion}, actual ${current ? current.version : "(instance missing)"} — the losing writer's transaction rolls back whole; re-read and re-project against current state`,
        {
          instanceId,
          expectedVersion: opts.expectedVersion,
          actualVersion: current?.version ?? null,
        },
      );
    }
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
    currentStepId: row.current_step_id,
    hopCount: row.hop_count,
    fallbackSynthesis: row.fallback_synthesis,
    lastContinuationDecision: row.last_continuation_decision_json
      ? (JSON.parse(row.last_continuation_decision_json) as Record<string, unknown>)
      : null,
    completedAt: row.completed_at,
    version: row.version ?? 0,
    resumeCount: row.resume_count ?? 0,
    hopsBaseline: row.hops_baseline ?? 0,
    boundRig: row.bound_rig ?? null,
  };
}
