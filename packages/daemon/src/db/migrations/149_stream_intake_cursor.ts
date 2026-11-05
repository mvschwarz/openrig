import type { Migration } from "../migrate.js";

/** Stream intake cursor table tracking the last processed stream sort key. */
export const streamIntakeCursorSchema: Migration = {
  name: "149_stream_intake_cursor.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS stream_intake_cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_sort_key TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_stream_items_archived_sort_key ON stream_items(archived_at, stream_sort_key);
    CREATE INDEX IF NOT EXISTS idx_stream_items_sort_key ON stream_items(stream_sort_key);
  `,
};
