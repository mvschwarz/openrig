import type { Migration } from "../migrate.js";

// Quiet hours for a person: one current quiet window per person, a daily local rule or an until-time, in a stored
// IANA timezone. The row is never deleted: the revision counts every set, replace, extend and clear, so a job armed for
// an older revision can tell that it's stale. "End" closes only the current occurrence (ended_occurrence); a new
// revision clears it. `source` is `manual` today; it leaves room for a window set by something else.
export const humanQuietWindowsSchema: Migration = {
  name: "118_human_quiet_windows.sql",
  sql: `
    CREATE TABLE human_quiet_windows (
      entity_id        TEXT PRIMARY KEY,
      window_id        TEXT NOT NULL UNIQUE,
      revision         INTEGER NOT NULL,
      kind             TEXT NOT NULL CHECK (kind IN ('daily', 'until')),
      timezone         TEXT NOT NULL,
      daily_start      TEXT,
      daily_end        TEXT,
      until_at         TEXT,
      source           TEXT NOT NULL,
      set_by           TEXT NOT NULL,
      set_at           TEXT NOT NULL,
      ended_occurrence TEXT,
      ended_by         TEXT,
      ended_at         TEXT,
      cleared_by       TEXT,
      cleared_at       TEXT,
      CHECK ((kind = 'daily' AND daily_start IS NOT NULL AND daily_end IS NOT NULL AND until_at IS NULL)
          OR (kind = 'until' AND until_at IS NOT NULL AND daily_start IS NULL AND daily_end IS NULL))
    );
  `,
};
