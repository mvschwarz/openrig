import type { Migration } from "../migrate.js";

export const startupContextSchema: Migration = {
  name: "015_startup_context.sql",
  sql: `
    -- node_startup_context: persisted startup context for restore replay
    CREATE TABLE IF NOT EXISTS node_startup_context (
      node_id                 TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      projection_entries_json TEXT NOT NULL,
      resolved_files_json     TEXT NOT NULL,
      startup_actions_json    TEXT NOT NULL,
      runtime                 TEXT NOT NULL,
      created_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `,
};
