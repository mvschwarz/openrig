import type { Migration } from "../migrate.js";

// observed_pid identifies the matched native process, which can be a child of the pane's shell.
// Do not backfill the pane PID from it: old wrapper verdicts must be refreshed by the reconciler.
export const seatIdentityPanePidSchema: Migration = {
  name: "119_seat_identity_pane_pid.sql",
  sql: "ALTER TABLE seat_identity_verdicts ADD COLUMN observed_pane_pid INTEGER;",
};
