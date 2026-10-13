import type { Migration } from "../migrate.js";

/** Physical staging/cutover can straddle a daemon restart. Config and phase
 * commit together; recovery never infers a committed switch from a tmux name. */
export const seatRuntimeSwitchesSchema: Migration = {
  name: "104_seat_runtime_switches.sql",
  sql: `CREATE TABLE seat_runtime_switches (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL UNIQUE REFERENCES nodes(id) ON DELETE CASCADE,
    canonical_session TEXT NOT NULL,
    staging_session TEXT NOT NULL UNIQUE,
    predecessor_pane TEXT NOT NULL,
    successor_pane TEXT,
    successor_resume_type TEXT,
    successor_resume_token TEXT,
    predecessor_generation TEXT NOT NULL,
    successor_generation TEXT NOT NULL UNIQUE,
    from_runtime TEXT NOT NULL,
    to_runtime TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'preparing' CHECK (phase IN ('preparing', 'committed'))
  );`,
};
