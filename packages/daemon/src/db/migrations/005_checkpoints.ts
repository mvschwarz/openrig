import type { Migration } from "../migrate.js";

export const checkpointsSchema: Migration = {
  name: "005_checkpoints.sql",
  sql: `
    -- checkpoints: per-agent recovery data
    -- FK to nodes.id with CASCADE — checkpoint is node-scoped recovery data,
    -- not audit trail. When a node is deleted, its checkpoints are no longer useful.
    CREATE TABLE checkpoints (
      id              TEXT PRIMARY KEY,
      node_id         TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      summary         TEXT NOT NULL,
      current_task    TEXT,
      next_step       TEXT,
      blocked_on      TEXT,
      key_artifacts   TEXT,
      confidence      TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_checkpoints_node ON checkpoints(node_id, created_at);
  `,
};
