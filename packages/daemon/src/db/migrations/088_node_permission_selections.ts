import type { Migration } from "../migrate.js";

// Explicit future-launch choices; policy provenance and native rules stay separate.
export const nodePermissionSelectionsSchema: Migration = {
  name: "088_node_permission_selections.sql",
  sql: `
    CREATE TABLE node_permission_selections (
      node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      runtime TEXT NOT NULL CHECK (runtime IN ('codex', 'claude-code')),
      mode TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    ALTER TABLE applied_launch_observations ADD COLUMN approval_policy TEXT;
  `,
};
