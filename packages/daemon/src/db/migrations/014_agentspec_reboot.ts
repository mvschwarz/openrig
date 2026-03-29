import type { Migration } from "../migrate.js";

export const agentspecRebootSchema: Migration = {
  name: "014_agentspec_reboot.sql",
  sql: `
    -- pods: bounded context domains within a rig
    CREATE TABLE pods (
      id                      TEXT PRIMARY KEY,
      rig_id                  TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      label                   TEXT NOT NULL,
      summary                 TEXT,
      continuity_policy_json  TEXT,
      created_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- continuity_state: per-node continuity operational state
    CREATE TABLE continuity_state (
      pod_id        TEXT NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
      node_id       TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      status        TEXT NOT NULL DEFAULT 'healthy',
      artifacts_json TEXT,
      last_sync_at  TEXT,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (pod_id, node_id)
    );

    -- nodes: add pod membership + AgentSpec identity
    ALTER TABLE nodes ADD COLUMN pod_id TEXT REFERENCES pods(id) ON DELETE SET NULL;
    ALTER TABLE nodes ADD COLUMN agent_ref TEXT;
    ALTER TABLE nodes ADD COLUMN profile TEXT;
    ALTER TABLE nodes ADD COLUMN label TEXT;
    ALTER TABLE nodes ADD COLUMN resolved_spec_name TEXT;
    ALTER TABLE nodes ADD COLUMN resolved_spec_version TEXT;
    ALTER TABLE nodes ADD COLUMN resolved_spec_hash TEXT;

    -- sessions: add startup state tracking
    ALTER TABLE sessions ADD COLUMN startup_status TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE sessions ADD COLUMN startup_completed_at TEXT;

    -- Backfill: all pre-migration sessions are definitionally post-startup
    UPDATE sessions SET startup_status = 'ready';

    -- checkpoints: add pod/continuity metadata for continuity-aware restore
    ALTER TABLE checkpoints ADD COLUMN pod_id TEXT REFERENCES pods(id) ON DELETE SET NULL;
    ALTER TABLE checkpoints ADD COLUMN continuity_source TEXT;
    ALTER TABLE checkpoints ADD COLUMN continuity_artifacts_json TEXT;
  `,
};
