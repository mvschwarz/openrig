import type { Migration } from "../migrate.js";

/**
 * OPR.0.7.0.2 (cost reporting, Pi atom): one row per usage-bearing entry Pi has PERSISTED in a session, keyed by
 * the Pi session id and the entry id, so a replay, catch-up or restart that returns the entry again stores
 * nothing new. `origin` keeps a fork's or branch's copied entries ("inherited") apart from the occupant's own
 * spend; "unknown" when the session header couldn't be read. `cost_total` is Pi's model-priced estimate and
 * stays NULL when the entry carried no cost (absent, never zero).
 */
export const piUsageEntriesSchema: Migration = {
  name: "107_pi_usage_entries.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS pi_usage_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pi_session_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      parent_entry_id TEXT,
      entry_timestamp TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('assistant', 'usage', 'tool_result', 'compaction', 'branch_summary')),
      usage_category TEXT,
      provider TEXT,
      model TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      cost_total REAL,
      stop_reason TEXT,
      origin TEXT NOT NULL CHECK (origin IN ('own', 'inherited', 'unknown')),
      seat_session TEXT NOT NULL,
      node_id TEXT,
      occupant_generation TEXT,
      recorded_at TEXT NOT NULL,
      UNIQUE (pi_session_id, entry_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pi_usage_entries_seat
      ON pi_usage_entries(seat_session, pi_session_id, entry_timestamp);
  `,
};
