import type { Migration } from "../migrate.js";

/**
 * #3625: the label of the account a seat's applied reference came from, and that account's reference as the apply used
 * it, kept with the seat's applied reference. A later result that moved nothing (unchanged, refused, failed) replaces the
 * seat's latest label and kind, but not these, so a seat that still follows an earlier apply is still known to be on that
 * apply's account, and a label later pointed at another reference isn't mistaken for it. Existing applied references take
 * the label of the switch that gave them, and the account's reference where the seat's own shows it (a Claude file, or a
 * Codex login switched in place); a seat moved to a prepared home has none and is moved again by the next apply.
 */
export const providerAssignmentAppliedLabelSchema: Migration = {
  name: "182_provider_assignment_applied_label.sql",
  sql: `
    ALTER TABLE provider_assignment_results ADD COLUMN applied_label TEXT;
    ALTER TABLE provider_assignment_results ADD COLUMN applied_account TEXT;
    UPDATE provider_assignment_results SET applied_label = label
      WHERE kind IN ('switched', 'pending_successor') AND (ref_file IS NOT NULL OR codex_home IS NOT NULL OR codex_login IS NOT NULL);
    UPDATE provider_assignment_results SET applied_account = json_object('kind',
        CASE WHEN ref_kind = 'api-key' THEN 'claude_api_key_file' ELSE 'claude_token_file' END,
        'file', ref_file, 'codexHome', NULL, 'login', NULL)
      WHERE applied_label IS NOT NULL AND ref_file IS NOT NULL;
    UPDATE provider_assignment_results SET applied_account = json_object('kind', 'codex_saved_login',
        'file', NULL, 'codexHome', codex_home, 'login', codex_login)
      WHERE applied_label IS NOT NULL AND ref_file IS NULL AND codex_home IS NOT NULL AND codex_login IS NOT NULL;
  `,
};
