import type { Migration } from "../migrate.js";

// SQLite cannot alter a CHECK constraint, so the table is rebuilt with cursor added.
// Rows and their columns are copied unchanged.
export const nodePermissionSelectionsCursorSchema: Migration = {
  name: "093_node_permission_selections_cursor.sql",
  sql: `
    CREATE TABLE node_permission_selections_next (
      node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      runtime TEXT NOT NULL CHECK (runtime IN ('codex', 'claude-code', 'cursor')),
      mode TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO node_permission_selections_next (node_id, runtime, mode, actor, reason, updated_at)
      SELECT node_id, runtime, mode, actor, reason, updated_at FROM node_permission_selections;
    DROP TABLE node_permission_selections;
    ALTER TABLE node_permission_selections_next RENAME TO node_permission_selections;
  `,
};
