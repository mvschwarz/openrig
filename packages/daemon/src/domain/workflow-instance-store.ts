// PL-004 Phase D: workflow instance store.
//
// Owns CRUD on workflow_instances. Frontier tracking uses
// current_frontier_json (serialized JSON array of qitem_ids). Survives
// daemon restart without filesystem reconciliation: list/getById query
// SQLite directly.

import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type {
  WorkflowFailureOccurrence,
  WorkflowFrontierBinding,
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
  lifecycle_operation_key?: string | null;
  compiled_input_digest?: string | null;
  lifecycle_binding_json?: string | null;
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
  lifecycle?: {
    operationKey: string;
    compiledInputDigest: string;
    binding: Record<string, unknown>;
  };
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
  private readonly hasLifecycleColumns: boolean;
  private readonly hasFrontierBindingsTable: boolean;
  private readonly hasFailureOccurrencesTable: boolean;

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.hasVersionColumn = detectInstanceColumn(db, "version");
    this.hasResumeColumns = detectInstanceColumn(db, "resume_count");
    this.hasBoundRigColumn = detectInstanceColumn(db, "bound_rig");
    this.hasLifecycleColumns = detectInstanceColumn(db, "lifecycle_operation_key");
    this.hasFrontierBindingsTable = tableExists(db, "workflow_frontier_bindings");
    this.hasFailureOccurrencesTable = tableExists(db, "workflow_failure_occurrences");
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
    const lifecycleCols = this.hasLifecycleColumns
      ? ", lifecycle_operation_key, compiled_input_digest, lifecycle_binding_json"
      : "";
    const lifecycleVals = this.hasLifecycleColumns ? ", ?, ?, ?" : "";
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
    if (this.hasLifecycleColumns) {
      params.push(
        input.lifecycle?.operationKey ?? null,
        input.lifecycle?.compiledInputDigest ?? null,
        input.lifecycle ? JSON.stringify(input.lifecycle.binding) : null,
      );
    }
    this.db
      .prepare(
        `INSERT INTO workflow_instances (
           instance_id, workflow_name, workflow_version, created_by_session,
           created_at, status, current_frontier_json, current_step_id, hop_count${boundRigCol}${lifecycleCols}
         ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 0${boundRigVal}${lifecycleVals})`,
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

  getByLifecycleOperationKey(operationKey: string): WorkflowInstance | null {
    if (!this.hasLifecycleColumns) return null;
    const row = this.db
      .prepare(`SELECT * FROM workflow_instances WHERE lifecycle_operation_key = ?`)
      .get(operationKey) as InstanceRow | undefined;
    return row ? rowToInstance(row) : null;
  }

  bindFrontierPacket(input: {
    instanceId: string;
    packetId: string;
    stepId: string;
    branchDrive?: number;
    hopCount?: number;
    hopsBaseline?: number;
  }): WorkflowFrontierBinding {
    if (!this.hasFrontierBindingsTable) {
      throw new WorkflowInstanceError("frontier_bindings_unavailable", "packet-addressed workflow state requires migration 079");
    }
    const createdAt = this.now().toISOString();
    this.db.prepare(
      `INSERT INTO workflow_frontier_bindings
       (instance_id, packet_id, step_id, branch_drive, hop_count, hops_baseline, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.instanceId,
      input.packetId,
      input.stepId,
      input.branchDrive ?? 0,
      input.hopCount ?? 0,
      input.hopsBaseline ?? 0,
      createdAt,
    );
    return this.getFrontierBinding(input.instanceId, input.packetId)!;
  }

  removeFrontierBinding(instanceId: string, packetId: string): void {
    if (!this.hasFrontierBindingsTable) return;
    this.db.prepare(`DELETE FROM workflow_frontier_bindings WHERE instance_id = ? AND packet_id = ?`)
      .run(instanceId, packetId);
  }

  getFrontierBinding(instanceId: string, packetId: string): WorkflowFrontierBinding | null {
    if (!this.hasFrontierBindingsTable) return null;
    const row = this.db.prepare(
      `SELECT * FROM workflow_frontier_bindings WHERE instance_id = ? AND packet_id = ?`,
    ).get(instanceId, packetId) as FrontierBindingRow | undefined;
    return row ? rowToFrontierBinding(row) : null;
  }

  listFrontierBindings(instanceId: string): WorkflowFrontierBinding[] {
    if (!this.hasFrontierBindingsTable) return [];
    const rows = this.db.prepare(
      `SELECT * FROM workflow_frontier_bindings WHERE instance_id = ? ORDER BY created_at, packet_id`,
    ).all(instanceId) as FrontierBindingRow[];
    return rows.map(rowToFrontierBinding);
  }

  recordFailureOccurrence(input: {
    instanceId: string;
    failedPacketId: string;
    stepId: string;
    branchDrive?: number;
    hopCount?: number;
    hopsBaseline?: number;
    failureReason?: string | null;
  }): WorkflowFailureOccurrence {
    if (!this.hasFailureOccurrencesTable) {
      throw new WorkflowInstanceError("failure_occurrences_unavailable", "branch-local workflow recovery requires migration 079");
    }
    const failedAt = this.now().toISOString();
    this.db.prepare(
      `INSERT INTO workflow_failure_occurrences
       (occurrence_id, instance_id, failed_packet_id, step_id, branch_drive,
        hop_count, hops_baseline, failure_reason, status, failed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unresolved', ?)`,
    ).run(
      input.failedPacketId,
      input.instanceId,
      input.failedPacketId,
      input.stepId,
      input.branchDrive ?? 0,
      input.hopCount ?? 0,
      input.hopsBaseline ?? 0,
      input.failureReason ?? null,
      failedAt,
    );
    return this.getFailureOccurrence(input.instanceId, input.failedPacketId)!;
  }

  getFailureOccurrence(instanceId: string, occurrenceId: string): WorkflowFailureOccurrence | null {
    if (!this.hasFailureOccurrencesTable) return null;
    const row = this.db.prepare(
      `SELECT * FROM workflow_failure_occurrences WHERE instance_id = ? AND occurrence_id = ?`,
    ).get(instanceId, occurrenceId) as FailureOccurrenceRow | undefined;
    return row ? rowToFailureOccurrence(row) : null;
  }

  listFailureOccurrences(instanceId: string, status?: "unresolved" | "resolved"): WorkflowFailureOccurrence[] {
    if (!this.hasFailureOccurrencesTable) return [];
    const rows = status
      ? this.db.prepare(`SELECT * FROM workflow_failure_occurrences WHERE instance_id = ? AND status = ? ORDER BY failed_at, occurrence_id`).all(instanceId, status)
      : this.db.prepare(`SELECT * FROM workflow_failure_occurrences WHERE instance_id = ? ORDER BY failed_at, occurrence_id`).all(instanceId);
    return (rows as FailureOccurrenceRow[]).map(rowToFailureOccurrence);
  }

  resolveFailureOccurrence(instanceId: string, occurrenceId: string, redrivePacketId: string, resumeDecision?: string): void {
    if (!this.hasFailureOccurrencesTable) return;
    const info = this.db.prepare(
      `UPDATE workflow_failure_occurrences
       SET status = 'resolved', redrive_packet_id = ?, resume_decision = ?, resolved_at = ?
       WHERE instance_id = ? AND occurrence_id = ? AND status = 'unresolved'`,
    ).run(redrivePacketId, resumeDecision ?? null, this.now().toISOString(), instanceId, occurrenceId);
    if (info.changes === 0) {
      throw new WorkflowInstanceError(
        "failure_occurrence_not_unresolved",
        `failure occurrence ${occurrenceId} is not unresolved for instance ${instanceId}`,
        { instanceId, occurrenceId },
      );
    }
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
    lifecycleOperationKey: row.lifecycle_operation_key ?? null,
    compiledInputDigest: row.compiled_input_digest ?? null,
    lifecycleBinding: row.lifecycle_binding_json
      ? (JSON.parse(row.lifecycle_binding_json) as Record<string, unknown>)
      : null,
  };
}

interface FrontierBindingRow {
  instance_id: string;
  packet_id: string;
  step_id: string;
  branch_drive: number;
  hop_count: number;
  hops_baseline: number;
  created_at: string;
}

interface FailureOccurrenceRow {
  occurrence_id: string;
  instance_id: string;
  failed_packet_id: string;
  step_id: string;
  branch_drive: number;
  hop_count: number;
  hops_baseline: number;
  failure_reason: string | null;
  status: "unresolved" | "resolved";
  redrive_packet_id: string | null;
  resume_decision: string | null;
  failed_at: string;
  resolved_at: string | null;
}

function rowToFrontierBinding(row: FrontierBindingRow): WorkflowFrontierBinding {
  return {
    instanceId: row.instance_id,
    packetId: row.packet_id,
    stepId: row.step_id,
    branchDrive: row.branch_drive,
    hopCount: row.hop_count,
    hopsBaseline: row.hops_baseline,
    createdAt: row.created_at,
  };
}

function rowToFailureOccurrence(row: FailureOccurrenceRow): WorkflowFailureOccurrence {
  return {
    occurrenceId: row.occurrence_id,
    instanceId: row.instance_id,
    failedPacketId: row.failed_packet_id,
    stepId: row.step_id,
    branchDrive: row.branch_drive,
    hopCount: row.hop_count,
    hopsBaseline: row.hops_baseline,
    failureReason: row.failure_reason,
    status: row.status,
    redrivePacketId: row.redrive_packet_id,
    resumeDecision: row.resume_decision,
    failedAt: row.failed_at,
    resolvedAt: row.resolved_at,
  };
}

function tableExists(db: Database.Database, tableName: string): boolean {
  try {
    return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName) !== undefined;
  } catch {
    return false;
  }
}
