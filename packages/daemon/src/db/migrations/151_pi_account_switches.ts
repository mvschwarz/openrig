import type { Migration } from "../migrate.js";

/** Widen runtime switches to Pi while retaining history and interrupted cutovers. */
export const piAccountSwitchesSchema: Migration = {
  name: "151_pi_account_switches.sql",
  sql: `
    CREATE TABLE seat_runtime_switches_pi (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      canonical_session TEXT NOT NULL,
      staging_session TEXT NOT NULL UNIQUE,
      predecessor_pane TEXT NOT NULL,
      successor_pane TEXT,
      predecessor_generation TEXT NOT NULL,
      successor_generation TEXT NOT NULL UNIQUE,
      from_runtime TEXT NOT NULL CHECK (from_runtime IN ('codex', 'claude-code', 'pi')),
      to_runtime TEXT NOT NULL CHECK (to_runtime IN ('codex', 'claude-code', 'pi')),
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

    INSERT INTO seat_runtime_switches_pi SELECT * FROM seat_runtime_switches;
    DROP TABLE seat_runtime_switches;
    ALTER TABLE seat_runtime_switches_pi RENAME TO seat_runtime_switches;
    CREATE UNIQUE INDEX idx_seat_runtime_switches_open ON seat_runtime_switches(node_id)
      WHERE phase IN ('preparing', 'confirmed', 'committed');
    CREATE INDEX idx_seat_runtime_switches_predecessor ON seat_runtime_switches(node_id, predecessor_generation)
      WHERE committed_at IS NOT NULL;
  `,
};
