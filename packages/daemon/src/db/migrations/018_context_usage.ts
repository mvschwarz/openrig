import type { Migration } from "../migrate.js";

export const contextUsageSchema: Migration = {
  name: "018_context_usage.sql",
  sql: `
    CREATE TABLE context_usage (
      node_id                 TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      session_id              TEXT,
      session_name            TEXT,
      availability            TEXT NOT NULL DEFAULT 'unknown',
      reason                  TEXT,
      source                  TEXT,
      used_percentage         REAL,
      remaining_percentage    REAL,
      context_window_size     INTEGER,
      total_input_tokens      INTEGER,
      total_output_tokens     INTEGER,
      current_usage           TEXT,
      transcript_path         TEXT,
      sampled_at              TEXT,
      updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `,
};
