import type { Migration } from "../migrate.js";

/**
 * #3513: the last Remote Control session a Claude seat's own hooks reported (Claude Code's
 * `CLAUDE_CODE_BRIDGE_SESSION_ID`), one row per node. The row is bound to the occupant generation and the Claude
 * conversation that reported it, so a delayed event from an earlier session can't replace the current seat's
 * observation, and the node read shows it only while both are still the seat's current ones. `session_id` NULL means a
 * later hook of that same occupant and conversation saw the variable absent. Deleting the node takes the row with it.
 */
export const remoteControlObservationsSchema: Migration = {
  name: "179_remote_control_observations.sql",
  sql: `
    CREATE TABLE remote_control_observations (
      node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      occupant_generation TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      session_id TEXT,
      observed_at TEXT NOT NULL
    );
  `,
};
