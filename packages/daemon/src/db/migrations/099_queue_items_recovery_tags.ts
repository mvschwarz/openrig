import type { Migration } from "../migrate.js";

// findQueueRecovery and the stuck sweep's dedup lookup search queue_items by an exact tag
// (`recovery-for:<id>`, `stuck-sweep:<kind>:<id>`). No index could serve a json_each membership test,
// so every call scanned and parsed the whole table: once per pending/in-progress row projected by
// getById, list and whoami, and several times per stuck candidate in the sweep and the wake ladder.
// This partial index holds only the rows whose tag text could carry either tag (a few percent of the
// table), and the queries repeat the matching term, so the planner uses it without changing which row
// is chosen. Valid JSON writes a string either verbatim or with backslash escapes, so the first group
// covers every row whose decoded tags can equal a recovery tag. Index-only: no table, trigger or backfill.
// Keep the parenthesised group byte-identical to RECOVERY_TAG_ROWS in queue-recovery.ts: SQLite uses a
// partial index only when the query repeats a term of its WHERE clause.
export const queueItemsRecoveryTagsSchema: Migration = {
  name: "099_queue_items_recovery_tags.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_queue_items_recovery_tags
      ON queue_items(qitem_id)
      WHERE (tags LIKE '%"recovery-for:%' OR tags LIKE '%\\%') OR tags LIKE '%"stuck-sweep:%';
  `,
};
