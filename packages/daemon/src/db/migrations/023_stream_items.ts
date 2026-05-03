import type { Migration } from "../migrate.js";

/**
 * L1 — Stream (PL-004 Phase A).
 *
 * Append-only intake/audit root for the coordination primitive. Items are
 * immutable after emit; ordered by `(ts_emitted, stream_sort_key)`. Hints
 * are advisory; classifier (L2, future Phase B) is authoritative on routing.
 *
 * Indexes:
 *   - PRIMARY KEY on stream_item_id (ULID; monotonic per host)
 *   - source-session lookup
 *   - hint-destination lookup
 *   - composite (ts_emitted, stream_sort_key) for chronological cursor pagination
 */
export const streamItemsSchema: Migration = {
  name: "023_stream_items.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS stream_items (
      stream_item_id TEXT PRIMARY KEY,
      ts_emitted TEXT NOT NULL,
      stream_sort_key TEXT NOT NULL,
      source_session TEXT NOT NULL,
      body TEXT NOT NULL,
      format TEXT NOT NULL DEFAULT 'text',
      hint_type TEXT,
      hint_urgency TEXT,
      hint_destination TEXT,
      hint_tags TEXT,
      interrupt INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_stream_items_source ON stream_items(source_session);
    CREATE INDEX IF NOT EXISTS idx_stream_items_hint_destination ON stream_items(hint_destination);
    CREATE INDEX IF NOT EXISTS idx_stream_items_chronological ON stream_items(ts_emitted, stream_sort_key);
    CREATE INDEX IF NOT EXISTS idx_stream_items_archived ON stream_items(archived_at);
  `,
};
