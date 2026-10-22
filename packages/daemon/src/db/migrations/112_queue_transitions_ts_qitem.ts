import type { Migration } from "../migrate.js";

// Recent queue activity is read newest first by (ts, transition_id) across live and archived
// history, stopping at the requested count. Neither table had an index in that order, so each read
// sorted every in-scope transition. These indexes give each table that order and carry qitem_id, so a
// transition outside the read's scope is rejected from the index entry without reading its row.
export const queueTransitionsTsQitemSchema: Migration = {
  name: "112_queue_transitions_ts_qitem.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_queue_transitions_ts_qitem
      ON queue_transitions(ts, transition_id, qitem_id);
    CREATE INDEX IF NOT EXISTS idx_queue_transitions_archive_ts_qitem
      ON queue_transitions_archive(ts, transition_id, qitem_id);
  `,
};
