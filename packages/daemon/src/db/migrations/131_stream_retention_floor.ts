import type { Migration } from "../migrate.js";

/**
 * Slice 22: stream retention never deletes history that existed before it arrived. On an install that already has
 * stream items, the newest one at upgrade becomes the floor, and retention prunes only items emitted after it. A fresh
 * install has no items, so no floor, and retention applies to everything.
 */
export const streamRetentionFloorSchema: Migration = {
  name: "131_stream_retention_floor.sql",
  sql: `
    CREATE TABLE stream_retention_floor (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      floor_ts TEXT NOT NULL,
      floor_key TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
    INSERT INTO stream_retention_floor (id, floor_ts, floor_key, recorded_at)
      SELECT 1, ts_emitted, stream_sort_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM stream_items
       ORDER BY ts_emitted DESC, stream_sort_key DESC LIMIT 1;
  `,
};
