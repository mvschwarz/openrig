import type { Migration } from "../migrate.js";

/**
 * Slice 22 outcome 9: hub readers. One subscription per reader seat: a filter over the existing hint fields and the
 * reader's own read cursor, kept as (ts_emitted, stream_sort_key) so it still orders after its item is pruned. A cursor
 * is read progress, never a disposition. `stream_retention_marks` records how far stream retention has pruned, so a
 * reader whose cursor falls behind it is told about the gap instead of reading an empty page as complete. A body
 * stored truncated at the emit cap records its kept and original sizes, so every reader can tell discarded content
 * from a shortened excerpt.
 */
export const streamSubscriptionsSchema: Migration = {
  name: "130_stream_subscriptions.sql",
  sql: `
    CREATE TABLE stream_subscriptions (
      reader_session TEXT PRIMARY KEY,
      hint_tags TEXT,
      hint_type TEXT,
      read_through_ts TEXT NOT NULL,
      read_through_key TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    ALTER TABLE stream_items ADD COLUMN body_kept_bytes INTEGER;
    ALTER TABLE stream_items ADD COLUMN body_original_bytes INTEGER;
    CREATE TABLE stream_retention_marks (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      pruned_through_ts TEXT NOT NULL,
      pruned_through_key TEXT NOT NULL,
      pruned_items INTEGER NOT NULL,
      pruned_at TEXT NOT NULL
    );
  `,
};
