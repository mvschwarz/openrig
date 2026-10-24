import type { Migration } from "../migrate.js";

/**
 * Slice 16 (live seat runtime switch, from #1214 by Aschenbath): one row per switch, kept as the seat's history.
 * Custody follows `committed_at` alone: the configuration commit and that stamp are one transaction, so the
 * predecessor holds the seat until it is set and the successor holds it after. `phase` is the physical progress
 * (staging, confirmation, retirement) that recovery finishes; `attention` says why recovery stopped short of
 * a decision, and status shows it instead of guessing. At most one open switch per seat.
 */
export const seatRuntimeSwitchesSchema: Migration = {
  name: "132_seat_runtime_switches.sql",
  sql: `
    CREATE TABLE seat_runtime_switches (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      canonical_session TEXT NOT NULL,
      staging_session TEXT NOT NULL UNIQUE,
      predecessor_pane TEXT NOT NULL,
      successor_pane TEXT,
      predecessor_generation TEXT NOT NULL,
      successor_generation TEXT NOT NULL UNIQUE,
      from_runtime TEXT NOT NULL CHECK (from_runtime IN ('codex', 'claude-code')),
      to_runtime TEXT NOT NULL CHECK (to_runtime IN ('codex', 'claude-code')),
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
    CREATE UNIQUE INDEX idx_seat_runtime_switches_open ON seat_runtime_switches(node_id)
      WHERE phase IN ('preparing', 'confirmed', 'committed');
    CREATE INDEX idx_seat_runtime_switches_predecessor ON seat_runtime_switches(node_id, predecessor_generation)
      WHERE committed_at IS NOT NULL;
  `,
};
