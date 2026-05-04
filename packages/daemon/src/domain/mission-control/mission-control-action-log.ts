// PL-005 Phase A: Mission Control action log (append-only).
//
// Owns inserts into mission_control_actions. Append-only at the API
// surface: only `record()` is exposed. UPDATE/DELETE/remove are not
// methods — direct SQL could mutate but is a contract violation
// enforced at this domain boundary (per PRD § Q5 + slice IMPL).
//
// Pattern mirrors PL-004 Phase C's WatchdogHistoryLog and Phase A's
// QueueTransitionLog and Phase D's WorkflowStepTrailLog.

import type Database from "better-sqlite3";
import { ulid } from "ulid";

export const MISSION_CONTROL_VERBS = [
  "approve",
  "deny",
  "route",
  "annotate",
  "hold",
  "drop",
  "handoff",
] as const;

export type MissionControlVerb = (typeof MISSION_CONTROL_VERBS)[number];

export interface MissionControlActionRecordInput {
  actionVerb: MissionControlVerb;
  qitemId: string | null;
  actorSession: string;
  actedAt: string;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  reason?: string | null;
  annotation?: string | null;
  notifyAttempted?: boolean;
  notifyResult?: string | null;
  auditNotes?: Record<string, unknown> | null;
}

export interface MissionControlActionEntry {
  actionId: string;
  actionVerb: MissionControlVerb;
  qitemId: string | null;
  actorSession: string;
  actedAt: string;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  reason: string | null;
  annotation: string | null;
  notifyAttempted: boolean;
  notifyResult: string | null;
  auditNotes: Record<string, unknown> | null;
}

interface ActionRow {
  action_id: string;
  action_verb: string;
  qitem_id: string | null;
  actor_session: string;
  acted_at: string;
  before_state_json: string | null;
  after_state_json: string | null;
  reason: string | null;
  annotation: string | null;
  notify_attempted: number;
  notify_result: string | null;
  audit_notes_json: string | null;
}

export class MissionControlActionLogError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MissionControlActionLogError";
  }
}

export class MissionControlActionLog {
  constructor(private readonly db: Database.Database) {}

  /**
   * Append an action record. Validates verb-specific required fields
   * (annotate → annotation; hold/drop → reason). Designed to compose
   * inside an outer caller-managed transaction (used by the
   * write-contract for the atomic 4-step handoff).
   */
  record(input: MissionControlActionRecordInput): MissionControlActionEntry {
    if (!MISSION_CONTROL_VERBS.includes(input.actionVerb)) {
      throw new MissionControlActionLogError(
        "verb_unknown",
        `unknown action_verb '${input.actionVerb}'; Phase A v1 supports: ${MISSION_CONTROL_VERBS.join(", ")}`,
        { actionVerb: input.actionVerb, supported: [...MISSION_CONTROL_VERBS] },
      );
    }
    if (input.actionVerb === "annotate" && !input.annotation) {
      throw new MissionControlActionLogError(
        "annotation_required",
        `action_verb=annotate requires annotation`,
        { actionVerb: input.actionVerb },
      );
    }
    if ((input.actionVerb === "hold" || input.actionVerb === "drop") && !input.reason) {
      throw new MissionControlActionLogError(
        "reason_required",
        `action_verb=${input.actionVerb} requires reason`,
        { actionVerb: input.actionVerb },
      );
    }
    const actionId = ulid();
    this.db
      .prepare(
        `INSERT INTO mission_control_actions (
           action_id, action_verb, qitem_id, actor_session, acted_at,
           before_state_json, after_state_json, reason, annotation,
           notify_attempted, notify_result, audit_notes_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        actionId,
        input.actionVerb,
        input.qitemId ?? null,
        input.actorSession,
        input.actedAt,
        input.beforeState ? JSON.stringify(input.beforeState) : null,
        input.afterState ? JSON.stringify(input.afterState) : null,
        input.reason ?? null,
        input.annotation ?? null,
        input.notifyAttempted ? 1 : 0,
        input.notifyResult ?? null,
        input.auditNotes ? JSON.stringify(input.auditNotes) : null,
      );
    return {
      actionId,
      actionVerb: input.actionVerb,
      qitemId: input.qitemId ?? null,
      actorSession: input.actorSession,
      actedAt: input.actedAt,
      beforeState: input.beforeState ?? null,
      afterState: input.afterState ?? null,
      reason: input.reason ?? null,
      annotation: input.annotation ?? null,
      notifyAttempted: Boolean(input.notifyAttempted),
      notifyResult: input.notifyResult ?? null,
      auditNotes: input.auditNotes ?? null,
    };
  }

  listRecent(limit = 50): MissionControlActionEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mission_control_actions
         ORDER BY acted_at DESC, rowid DESC LIMIT ?`,
      )
      .all(limit) as ActionRow[];
    return rows.map(rowToEntry);
  }

  listForQitem(qitemId: string, limit = 50): MissionControlActionEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mission_control_actions WHERE qitem_id = ?
         ORDER BY acted_at DESC, rowid DESC LIMIT ?`,
      )
      .all(qitemId, limit) as ActionRow[];
    return rows.map(rowToEntry);
  }

  listForActor(actorSession: string, limit = 50): MissionControlActionEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM mission_control_actions WHERE actor_session = ?
         ORDER BY acted_at DESC, rowid DESC LIMIT ?`,
      )
      .all(actorSession, limit) as ActionRow[];
    return rows.map(rowToEntry);
  }

  countAll(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM mission_control_actions`)
      .get() as { n: number };
    return row.n;
  }
}

function rowToEntry(row: ActionRow): MissionControlActionEntry {
  return {
    actionId: row.action_id,
    actionVerb: row.action_verb as MissionControlVerb,
    qitemId: row.qitem_id,
    actorSession: row.actor_session,
    actedAt: row.acted_at,
    beforeState: row.before_state_json
      ? (JSON.parse(row.before_state_json) as Record<string, unknown>)
      : null,
    afterState: row.after_state_json
      ? (JSON.parse(row.after_state_json) as Record<string, unknown>)
      : null,
    reason: row.reason,
    annotation: row.annotation,
    notifyAttempted: row.notify_attempted !== 0,
    notifyResult: row.notify_result,
    auditNotes: row.audit_notes_json
      ? (JSON.parse(row.audit_notes_json) as Record<string, unknown>)
      : null,
  };
}
