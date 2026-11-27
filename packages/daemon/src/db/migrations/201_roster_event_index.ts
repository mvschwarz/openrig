import type { Migration } from "../migrate.js";

/** Keep the snapshot tick's latest-roster read off the rig's unrelated event history, as in migration 084. */
export const rosterEventIndexSchema: Migration = {
  name: "201_roster_event_index.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_events_roster_rig_seq ON events(rig_id, seq DESC)
      WHERE type = 'topology.roster_recorded';
  `,
};
