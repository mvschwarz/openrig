import type { Migration } from "../migrate.js";

/**
 * #3625: the label of the account a seat's applied reference came from, kept with that reference. A later result that
 * moved nothing (unchanged, refused, failed) replaces the seat's latest label and kind, but not this, so a seat that
 * still follows an earlier apply is still known to be on that apply's account. Existing applied references take the
 * label of the switch that gave them.
 */
export const providerAssignmentAppliedLabelSchema: Migration = {
  name: "181_provider_assignment_applied_label.sql",
  sql: `
    ALTER TABLE provider_assignment_results ADD COLUMN applied_label TEXT;
    UPDATE provider_assignment_results SET applied_label = label
      WHERE kind IN ('switched', 'pending_successor') AND (ref_file IS NOT NULL OR codex_home IS NOT NULL OR codex_login IS NOT NULL);
  `,
};
