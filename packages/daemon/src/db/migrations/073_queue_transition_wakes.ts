import type { Migration } from "../migrate.js";

// OPR.0.5.5.03 — wake evidence belongs to the append-only park transition,
// not to the mutable queue row. The side table keeps queue_transitions itself
// immutable and survives the active→archive lifecycle without rewriting history.
export const queueTransitionWakesSchema: Migration = {
  name: "073_queue_transition_wakes.sql",
  sql: `
    CREATE TABLE queue_transition_wakes (
      transition_id  INTEGER PRIMARY KEY,
      qitem_id       TEXT NOT NULL,
      phase          TEXT NOT NULL CHECK (phase IN ('armed', 'fired')),
      wake_kind      TEXT NOT NULL CHECK (wake_kind IN ('watchdog', 'timer', 'blocker')),
      wake_ref       TEXT NOT NULL,
      delivery_status TEXT
    );
    CREATE INDEX idx_queue_transition_wakes_qitem
      ON queue_transition_wakes (qitem_id, transition_id);
    CREATE INDEX idx_queue_transition_wakes_ref
      ON queue_transition_wakes (wake_ref, phase);
  `,
};
