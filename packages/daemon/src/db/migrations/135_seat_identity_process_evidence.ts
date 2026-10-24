import type { Migration } from "../migrate.js";

// The last process the identity poll observed for a seat, kept with its own observation time apart from the current
// verdict. A verdict that can't see the seat (tmux unavailable, session missing) honestly records no pid; startup
// reconcile reads this evidence instead, so a seat whose last observed process still runs isn't read as gone on a
// second restart either. Backfilled from current verdicts that carry a pid.
export const seatIdentityProcessEvidenceSchema: Migration = {
  name: "135_seat_identity_process_evidence.sql",
  sql: `
    ALTER TABLE seat_identity_verdicts ADD COLUMN evidence_pid INTEGER;
    ALTER TABLE seat_identity_verdicts ADD COLUMN evidence_pane_pid INTEGER;
    ALTER TABLE seat_identity_verdicts ADD COLUMN evidence_at TEXT;
    UPDATE seat_identity_verdicts
       SET evidence_pid = observed_pid, evidence_pane_pid = observed_pane_pid, evidence_at = observed_at
     WHERE observed_pid IS NOT NULL OR observed_pane_pid IS NOT NULL;
  `,
};
