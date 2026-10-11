import type { Migration } from "../migrate.js";

// A row's latest transitions are read in insertion (transition_id) order, which the wall-clock
// ts cannot stand in for when the clock moves backwards. idx_queue_transitions_qitem
// (qitem_id, ts) orders by ts, so a newest-first read by transition_id sorted the row's whole
// history. This index makes it a bounded reverse seek (OPR.0.7.0.12, the held row's park).
export const queueTransitionsQitemIdOrderSchema: Migration = {
  name: "098_queue_transitions_qitem_id_order.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_queue_transitions_qitem_id_order
      ON queue_transitions(qitem_id, transition_id);
  `,
};
