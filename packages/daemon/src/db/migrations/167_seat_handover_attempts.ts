import type { Migration } from "../migrate.js";

/**
 * #2985 / #2861: a handover that fails after the in-place respawn, with its successor launched, records the attempt
 * here, so `rig seat handover <seat> --recover` can later adopt that successor if it is running. The row keeps what
 * the failed handover alone knew: the generation it reserved for the successor (passed in its env), the pane it
 * respawned, the session id the daemon generated for the successor's launch (the same class of value as
 * sessions.resume_token: never logged, never in an event), and the source's execution outcome it produced (a rebuild's
 * primed set), which the recovery reports as is. The predecessor's generation and session say which
 * occupant the attempt replaced; once a launch or another handover holds the seat, the attempt is stale. At most one
 * open attempt per seat: a later failure abandons the earlier one, and a later committed handover closes it. A closed
 * attempt keeps no resume token.
 */
export const seatHandoverAttemptsSchema: Migration = {
  name: "167_seat_handover_attempts.sql",
  sql: `
    CREATE TABLE seat_handover_attempts (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      canonical_session TEXT NOT NULL,
      pane TEXT NOT NULL,
      runtime TEXT,
      successor_generation TEXT NOT NULL UNIQUE,
      predecessor_generation TEXT,
      predecessor_session_id TEXT NOT NULL,
      source_raw TEXT NOT NULL,
      reason TEXT NOT NULL,
      operator TEXT,
      resume_type TEXT,
      resume_token TEXT,
      -- What became of the context packet: delivered, sent but unconfirmed (it may still land), or not sent.
      context_delivery TEXT NOT NULL CHECK (context_delivery IN ('delivered', 'unconfirmed', 'not_sent')),
      -- What the launch named, carried to the commit that adopts it: launch-addition notes, the required startup files
      -- the successor started without (#2456), and the exact applied launch observation (W3). JSON, or NULL.
      launch_notes_json TEXT,
      started_without_required_json TEXT,
      applied_launch_json TEXT,
      -- The source's execution outcome the failed handover produced (a rebuild's primed set, gaps and empty-chain reason),
      -- reported as is by the recovery that adopts it. JSON, or NULL.
      source_outcome_json TEXT,
      -- The launch's frozen executable (#2341: the realpath it ran) and whether it is a #! script, as the Claude adapter's
      -- readiness proves a wrapper launch with them; NULL and 0 for a classic launch.
      executable TEXT,
      executable_is_script INTEGER NOT NULL DEFAULT 0 CHECK (executable_is_script IN (0, 1)),
      departing_process TEXT NOT NULL CHECK (departing_process IN ('ended-graceful', 'ended-forced')),
      failed_step TEXT NOT NULL,
      failure_code TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'failed' CHECK (phase IN ('failed', 'adopted', 'abandoned')),
      outcome TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE UNIQUE INDEX idx_seat_handover_attempts_open ON seat_handover_attempts(node_id) WHERE phase = 'failed';
  `,
};
