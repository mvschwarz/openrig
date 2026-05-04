// PL-005 Phase B: read-only audit-history browse over mission_control_actions.
//
// Filters: qitem_id (exact), action_verb (exact), actor_session (exact),
// since/until (acted_at range). Pagination via before_id + limit.
// Returns {rows, has_more, next_before_id} shape so the UI can paginate.
//
// Read-only: no writers, no UPDATE/DELETE methods. Phase A's
// MissionControlActionLog is the only writer; this layer only queries.

import type Database from "better-sqlite3";
import {
  type MissionControlActionEntry,
  type MissionControlVerb,
  MISSION_CONTROL_VERBS,
} from "./mission-control-action-log.js";

export interface AuditQueryInput {
  qitemId?: string;
  actionVerb?: string;
  actorSession?: string;
  /** ISO timestamp; rows with acted_at >= since are included. */
  since?: string;
  /** ISO timestamp; rows with acted_at <= until are included. */
  until?: string;
  /** Default 50; capped at 200. */
  limit?: number;
  /** Pagination cursor: returns rows whose action_id < beforeId. */
  beforeId?: string;
}

export interface AuditQueryResult {
  rows: MissionControlActionEntry[];
  hasMore: boolean;
  nextBeforeId: string | null;
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

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export class MissionControlAuditBrowse {
  constructor(private readonly db: Database.Database) {}

  query(input: AuditQueryInput): AuditQueryResult {
    if (input.actionVerb && !MISSION_CONTROL_VERBS.includes(input.actionVerb as MissionControlVerb)) {
      throw new Error(
        `unknown action_verb '${input.actionVerb}'; supported: ${MISSION_CONTROL_VERBS.join(", ")}`,
      );
    }
    const limit = clampLimit(input.limit);
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (input.qitemId) {
      where.push("qitem_id = ?");
      params.push(input.qitemId);
    }
    if (input.actionVerb) {
      where.push("action_verb = ?");
      params.push(input.actionVerb);
    }
    if (input.actorSession) {
      where.push("actor_session = ?");
      params.push(input.actorSession);
    }
    if (input.since) {
      where.push("acted_at >= ?");
      params.push(input.since);
    }
    if (input.until) {
      where.push("acted_at <= ?");
      params.push(input.until);
    }
    if (input.beforeId) {
      // Look up the cursor row's rowid so pagination uses SQLite's
      // monotonic insertion order (deterministic) rather than ULID
      // action_id (whose same-ms tail is random; non-deterministic
      // for tiebreaks). Filed lesson:
      // feedback_ulid_tiebreaker_nondeterministic.md.
      where.push("rowid < (SELECT rowid FROM mission_control_actions WHERE action_id = ?)");
      params.push(input.beforeId);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    // Fetch limit+1 to detect hasMore without a separate count query.
    // ORDER BY acted_at DESC primary; rowid DESC tiebreak (deterministic
    // insertion order; safer than ULID action_id for same-ms ties).
    const sql = `SELECT * FROM mission_control_actions ${whereClause}
       ORDER BY acted_at DESC, rowid DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit + 1) as ActionRow[];
    const hasMore = rows.length > limit;
    const trimmed = hasMore ? rows.slice(0, limit) : rows;
    const nextBeforeId = hasMore && trimmed.length > 0 ? trimmed[trimmed.length - 1]!.action_id : null;
    return {
      rows: trimmed.map(rowToEntry),
      hasMore,
      nextBeforeId,
    };
  }
}

function clampLimit(input: number | undefined): number {
  if (input === undefined || !Number.isFinite(input)) return DEFAULT_LIMIT;
  if (input < 1) return 1;
  if (input > MAX_LIMIT) return MAX_LIMIT;
  return Math.floor(input);
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
