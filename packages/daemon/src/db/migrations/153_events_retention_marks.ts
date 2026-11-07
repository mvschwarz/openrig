import type { Migration } from "../migrate.js";

/** The events retention pass's low-water mark: every seq at or below it has been checked against the allowlist
 *  named in prunable_types. A different allowlist restarts the pass from the oldest row. resume_seq is where a
 *  sweep that hit its batch cap stopped, so the next one continues from there; it is cleared when a pass reaches
 *  the newest row, and the pass after that starts again at the mark. */
export const eventsRetentionMarksSchema: Migration = {
  name: "153_events_retention_marks.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS events_retention_marks (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      low_water_seq INTEGER NOT NULL,
      resume_seq INTEGER,
      prunable_types TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
};
