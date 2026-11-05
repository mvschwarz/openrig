import type { Migration } from "../migrate.js";

/**
 * GET /api/queue/outbox/list?rig= matches session names by suffix, which no session index can serve. This index lets
 * that read walk the outbox newest-first and stop at its limit, instead of scanning and sorting the whole table. The
 * session columns ride along so the match is tested in the index, and only matching rows are read.
 */
export const outboxDispatchedIndexSchema: Migration = {
  name: "148_outbox_dispatched_index.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_outbox_entries_ts_dispatched ON outbox_entries(ts_dispatched, sender_session, destination_session);
  `,
};
