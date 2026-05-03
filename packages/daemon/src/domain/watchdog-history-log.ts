import type Database from "better-sqlite3";
import { ulid } from "ulid";

/**
 * Watchdog history log (PL-004 Phase C; append-only audit writer).
 *
 * Per slice IMPL § Guard Checkpoint Focus item 2:
 * - Pure `not_due` polls are NOT recorded (matches POC; minimizes
 *   table size). Only `sent` / `skipped` / `terminal` outcomes pass
 *   through this log.
 * - Append-only API surface: only `record()` exposed. UPDATE/DELETE
 *   are not exposed. SQLite has no view/role layer so direct SQL
 *   could mutate, but the contract is enforced at this domain
 *   boundary.
 */

export type WatchdogOutcome = "sent" | "skipped" | "terminal";

export interface WatchdogHistoryRecordInput {
  jobId: string;
  evaluatedAt: string;
  outcome: WatchdogOutcome;
  skipReason?: string | null;
  deliveryTargetSession?: string | null;
  deliveryStatus?: string | null;
  deliveryMessage?: string | null;
  evaluationNotes?: Record<string, unknown> | null;
}

export interface WatchdogHistoryEntry {
  historyId: string;
  jobId: string;
  evaluatedAt: string;
  outcome: WatchdogOutcome;
  skipReason: string | null;
  deliveryTargetSession: string | null;
  deliveryStatus: string | null;
  deliveryMessage: string | null;
  evaluationNotes: Record<string, unknown> | null;
}

interface HistoryRow {
  history_id: string;
  job_id: string;
  evaluated_at: string;
  outcome: string;
  skip_reason: string | null;
  delivery_target_session: string | null;
  delivery_status: string | null;
  delivery_message: string | null;
  evaluation_notes: string | null;
}

export class WatchdogHistoryLog {
  constructor(private readonly db: Database.Database) {}

  /**
   * Append a meaningful evaluation outcome. Returns the persisted entry.
   * Caller MUST NOT invoke this for `not_due` pure-skip outcomes — those
   * are not recorded (per POC + IMPL guidance).
   */
  record(input: WatchdogHistoryRecordInput): WatchdogHistoryEntry {
    const historyId = ulid();
    this.db
      .prepare(
        `INSERT INTO watchdog_history (
          history_id, job_id, evaluated_at, outcome,
          skip_reason, delivery_target_session, delivery_status,
          delivery_message, evaluation_notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        historyId,
        input.jobId,
        input.evaluatedAt,
        input.outcome,
        input.skipReason ?? null,
        input.deliveryTargetSession ?? null,
        input.deliveryStatus ?? null,
        input.deliveryMessage ?? null,
        input.evaluationNotes ? JSON.stringify(input.evaluationNotes) : null,
      );
    return {
      historyId,
      jobId: input.jobId,
      evaluatedAt: input.evaluatedAt,
      outcome: input.outcome,
      skipReason: input.skipReason ?? null,
      deliveryTargetSession: input.deliveryTargetSession ?? null,
      deliveryStatus: input.deliveryStatus ?? null,
      deliveryMessage: input.deliveryMessage ?? null,
      evaluationNotes: input.evaluationNotes ?? null,
    };
  }

  listForJob(jobId: string, limit = 50): WatchdogHistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM watchdog_history WHERE job_id = ?
         ORDER BY evaluated_at DESC, history_id DESC LIMIT ?`,
      )
      .all(jobId, limit) as HistoryRow[];
    return rows.map(rowToEntry);
  }

  listAll(limit = 100): WatchdogHistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM watchdog_history
         ORDER BY evaluated_at DESC, history_id DESC LIMIT ?`,
      )
      .all(limit) as HistoryRow[];
    return rows.map(rowToEntry);
  }

  countForJob(jobId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM watchdog_history WHERE job_id = ?`)
      .get(jobId) as { n: number };
    return row.n;
  }
}

function rowToEntry(row: HistoryRow): WatchdogHistoryEntry {
  return {
    historyId: row.history_id,
    jobId: row.job_id,
    evaluatedAt: row.evaluated_at,
    outcome: row.outcome as WatchdogOutcome,
    skipReason: row.skip_reason,
    deliveryTargetSession: row.delivery_target_session,
    deliveryStatus: row.delivery_status,
    deliveryMessage: row.delivery_message,
    evaluationNotes: row.evaluation_notes ? JSON.parse(row.evaluation_notes) : null,
  };
}
