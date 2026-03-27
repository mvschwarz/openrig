import type { Migration } from "../migrate.js";

export const discoveryFkFix: Migration = {
  name: "013_discovery_fk_fix.sql",
  sql: `
    -- Rebuild discovered_sessions with ON DELETE SET NULL on claimed_node_id FK.
    -- Preserves existing rows. Explicit column list for safety.

    ALTER TABLE discovered_sessions RENAME TO discovered_sessions_old;

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
      claimed_node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
      first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tmux_session, tmux_pane)
    );

    INSERT INTO discovered_sessions (id, tmux_session, tmux_window, tmux_pane, pid, cwd, active_command, runtime_hint, confidence, evidence_json, config_json, status, claimed_node_id, first_seen_at, last_seen_at)
    SELECT id, tmux_session, tmux_window, tmux_pane, pid, cwd, active_command, runtime_hint, confidence, evidence_json, config_json, status, claimed_node_id, first_seen_at, last_seen_at
    FROM discovered_sessions_old;

    DROP TABLE discovered_sessions_old;

    CREATE INDEX idx_discovered_status ON discovered_sessions(status);
  `,
};
