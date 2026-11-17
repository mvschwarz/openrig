import type { Migration } from "../migrate.js";

/** #2940: a seat that declares `keep_alive` (the resolved value, 0 = off) and its recovery budget. The budget row holds
 *  the current incident (the fall it counts, the session that fell and the one a recovery launched), the attempts
 *  spent, the last error and when it ran out or recovered. `last_outcome` is what the last attempt's launch came to,
 *  NULL while it runs or when the daemon stopped before writing it. It lives with the seat and is never reset by a daemon restart: an attempt is counted
 *  before its launch starts. */
export const nodeKeepAliveSchema: Migration = {
  name: "177_node_keep_alive.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN keep_alive INTEGER NOT NULL DEFAULT 0 CHECK (keep_alive IN (0, 1));

    CREATE TABLE node_keep_alive_budget (
      node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      incident_id TEXT NOT NULL,
      fallen_session_id TEXT,
      launched_session_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      last_error TEXT,
      exhausted_at TEXT,
      recovered_at TEXT,
      last_outcome TEXT CHECK (last_outcome IN ('recovered', 'failed', 'exhausted', 'adopted')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `,
};
