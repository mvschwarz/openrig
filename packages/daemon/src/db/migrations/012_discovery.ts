import type { Migration } from "../migrate.js";

export const discoverySchema: Migration = {
  name: "012_discovery.sql",
  sql: `
    CREATE TABLE discovered_sessions (
      id              TEXT PRIMARY KEY,
      tmux_session    TEXT NOT NULL,
      tmux_window     TEXT,
      tmux_pane       TEXT,
      pid             INTEGER,
      cwd             TEXT,
      active_command  TEXT,
      runtime_hint    TEXT NOT NULL DEFAULT 'unknown',
      confidence      TEXT NOT NULL DEFAULT 'low',
      evidence_json   TEXT,
      config_json     TEXT,
      status          TEXT NOT NULL DEFAULT 'active',
      claimed_node_id TEXT REFERENCES nodes(id),
      first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tmux_session, tmux_pane)
    );

    CREATE INDEX idx_discovered_status ON discovered_sessions(status);

    ALTER TABLE sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'launched';
  `,
};
