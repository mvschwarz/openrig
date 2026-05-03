import type { Migration } from "../migrate.js";

/**
 * L3 — Queue transitions append-only log (PL-004 Phase A).
 *
 * Every state mutation on a queue_item is appended here; the queue_items.state
 * column is the latest transition's value. This log is the authoritative
 * audit trail for hot-potato closure reasoning, watchdog evaluation, and
 * future workflow-runtime transactional-scribe semantics (Phase D).
 *
 * Append-only: no UPDATE / DELETE on this table from domain code.
 */
export const queueTransitionsSchema: Migration = {
  name: "025_queue_transitions.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS queue_transitions (
      transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
      qitem_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      state TEXT NOT NULL,
      transition_note TEXT,
      actor_session TEXT NOT NULL,
      closure_reason TEXT,
      closure_target TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_queue_transitions_qitem ON queue_transitions(qitem_id, ts);
    CREATE INDEX IF NOT EXISTS idx_queue_transitions_actor ON queue_transitions(actor_session);
  `,
};
