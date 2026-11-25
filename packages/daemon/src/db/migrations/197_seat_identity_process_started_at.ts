import type { Migration } from "../migrate.js";

// Exact process start times (`ps lstart`) observed when a verdict was proved, so
// consumers refuse reused PIDs only on positive start-identity disagreement.
export const seatIdentityProcessStartedAtSchema: Migration = {
  name: "197_seat_identity_process_started_at.sql",
  sql: `
    ALTER TABLE seat_identity_verdicts ADD COLUMN observed_pid_started_at TEXT;
    ALTER TABLE seat_identity_verdicts ADD COLUMN observed_pane_pid_started_at TEXT;
  `,
};
