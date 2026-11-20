import type { Migration } from "../migrate.js";

/**
 * Widen the runtime columns a switch writes, so a community harness's name (for example `cursor`) is storable, while
 * retaining history and interrupted cutovers.
 *
 * `seat_runtime_switches`: the service only accepts a harness name when its preset is installed, so the column holds a
 * name the daemon could launch. The CHECK keeps a non-empty name rather than a closed list, because a preset can be
 * installed or removed without rewriting this history.
 *
 * `node_permission_selections`: an explicit choice is still limited to codex/claude-code in code, so this only keeps the
 * table from rejecting a row that a future runtime's choice would write. Existing rows are copied unchanged.
 */
export const communityHarnessRuntimeSwitchesSchema: Migration = {
  name: "179_community_harness_runtime_switches.sql",
  sql: `
    CREATE TABLE seat_runtime_switches_harness (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      canonical_session TEXT NOT NULL,
      staging_session TEXT NOT NULL UNIQUE,
      predecessor_pane TEXT NOT NULL,
      successor_pane TEXT,
      predecessor_generation TEXT NOT NULL,
      successor_generation TEXT NOT NULL UNIQUE,
      from_runtime TEXT NOT NULL CHECK (length(trim(from_runtime)) > 0),
      to_runtime TEXT NOT NULL CHECK (length(trim(to_runtime)) > 0),
      phase TEXT NOT NULL DEFAULT 'preparing'
        CHECK (phase IN ('preparing', 'confirmed', 'committed', 'finished', 'abandoned')),
      reason TEXT NOT NULL,
      requested_by TEXT,
      plan_json TEXT NOT NULL,
      confirmation_note TEXT,
      confirmed_at TEXT,
      successor_resume_type TEXT,
      successor_resume_token TEXT,
      committed_at TEXT,
      -- When the switch should have finished (its successor's start plus the confirmation timeout); a waiting send says so.
      deadline_at TEXT NOT NULL,
      outcome TEXT,
      attention TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      CHECK ((phase IN ('committed', 'finished')) = (committed_at IS NOT NULL))
    );

    INSERT INTO seat_runtime_switches_harness SELECT * FROM seat_runtime_switches;
    DROP TABLE seat_runtime_switches;
    ALTER TABLE seat_runtime_switches_harness RENAME TO seat_runtime_switches;
    CREATE UNIQUE INDEX idx_seat_runtime_switches_open ON seat_runtime_switches(node_id)
      WHERE phase IN ('preparing', 'confirmed', 'committed');
    CREATE INDEX idx_seat_runtime_switches_predecessor ON seat_runtime_switches(node_id, predecessor_generation)
      WHERE committed_at IS NOT NULL;

    CREATE TABLE node_permission_selections_runtime (
      node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      runtime TEXT NOT NULL CHECK (length(trim(runtime)) > 0),
      mode TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO node_permission_selections_runtime SELECT * FROM node_permission_selections;
    DROP TABLE node_permission_selections;
    ALTER TABLE node_permission_selections_runtime RENAME TO node_permission_selections;
  `,
};
