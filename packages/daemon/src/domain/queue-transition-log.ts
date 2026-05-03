import type Database from "better-sqlite3";
import type { ClosureReason } from "./hot-potato-enforcer.js";

export interface QueueTransition {
  transitionId: number;
  qitemId: string;
  ts: string;
  state: string;
  transitionNote: string | null;
  actorSession: string;
  closureReason: ClosureReason | null;
  closureTarget: string | null;
}

export interface QueueTransitionInput {
  qitemId: string;
  state: string;
  actorSession: string;
  transitionNote?: string;
  closureReason?: ClosureReason;
  closureTarget?: string;
}

interface QueueTransitionRow {
  transition_id: number;
  qitem_id: string;
  ts: string;
  state: string;
  transition_note: string | null;
  actor_session: string;
  closure_reason: string | null;
  closure_target: string | null;
}

/**
 * Append-only transition log. Domain code MUST NOT update or delete rows here.
 * This log is the authoritative audit trail for queue state evolution.
 */
export class QueueTransitionLog {
  readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Append a transition. Designed to be called inside an outer caller-managed
   * `db.transaction()` so the transition row is atomic with the queue_items
   * UPDATE that produced it.
   */
  append(input: QueueTransitionInput): QueueTransition {
    const ts = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO queue_transitions (
          qitem_id, ts, state, transition_note, actor_session, closure_reason, closure_target
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.qitemId,
        ts,
        input.state,
        input.transitionNote ?? null,
        input.actorSession,
        input.closureReason ?? null,
        input.closureTarget ?? null
      );

    const row = this.db
      .prepare("SELECT * FROM queue_transitions WHERE transition_id = ?")
      .get(Number(result.lastInsertRowid)) as QueueTransitionRow;

    return this.rowToTransition(row);
  }

  listForQitem(qitemId: string): QueueTransition[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id ASC"
      )
      .all(qitemId) as QueueTransitionRow[];
    return rows.map((r) => this.rowToTransition(r));
  }

  listForActor(actorSession: string, limit = 100): QueueTransition[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM queue_transitions WHERE actor_session = ? ORDER BY transition_id DESC LIMIT ?"
      )
      .all(actorSession, limit) as QueueTransitionRow[];
    return rows.map((r) => this.rowToTransition(r));
  }

  private rowToTransition(row: QueueTransitionRow): QueueTransition {
    return {
      transitionId: row.transition_id,
      qitemId: row.qitem_id,
      ts: row.ts,
      state: row.state,
      transitionNote: row.transition_note,
      actorSession: row.actor_session,
      closureReason: row.closure_reason as ClosureReason | null,
      closureTarget: row.closure_target,
    };
  }
}
