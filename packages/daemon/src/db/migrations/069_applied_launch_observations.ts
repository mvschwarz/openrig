import type { Migration } from "../migrate.js";

// W3 permission-drift visibility: an APPLIED launch observation is a separate,
// generation-keyed fact. The occupant-tenure ledger stays append-only and is
// never repurposed as mutable observation storage.
export const appliedLaunchObservationsSchema: Migration = {
  name: "069_applied_launch_observations.sql",
  sql: `
    CREATE TABLE applied_launch_observations (
      generation_uuid TEXT PRIMARY KEY REFERENCES occupant_tenures(generation_uuid) ON DELETE CASCADE,
      runtime         TEXT NOT NULL,
      axis            TEXT NOT NULL,
      observation_state TEXT NOT NULL CHECK (observation_state IN ('observed', 'unknown')),
      value           TEXT,
      reason          TEXT,
      observed_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `,
};
