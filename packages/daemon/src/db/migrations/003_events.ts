import type { Migration } from "../migrate.js";

export const eventsSchema: Migration = {
  name: "003_events.sql",
  sql: `
    CREATE TABLE events (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      -- INTENTIONALLY NOT AN FK to rigs(id).
      -- Events are an append-only history log. They must survive rig deletion
      -- so the full timeline is preserved for replay and audit.
      rig_id      TEXT,
      -- INTENTIONALLY NOT AN FK to nodes(id).
      -- Same rationale: events must survive node deletion.
      node_id     TEXT,
      type        TEXT NOT NULL,
      payload     TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Primary query pattern: "all events for rig X after sequence N" (SSE replay)
    CREATE INDEX idx_events_rig_seq ON events(rig_id, seq);
  `,
};
