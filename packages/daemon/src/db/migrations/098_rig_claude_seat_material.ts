import type { Migration } from "../migrate.js";

/**
 * #875 — rigs.claude_seat_material column.
 *
 * Holds the rig-level `seat_material.claude-code` selection (`cwd` or `seat`), written by
 * RigRepository.setRigClaudeSeatMaterial at instantiate time. The Claude adapter reads it back
 * through a resolver on every launch path (fresh, fork, resume, restore, handover), so all of
 * them project into and launch from the same place. NULL = the cwd default.
 * Mirrors migration 085 (rigs.claude_managed_block_file).
 */
export const rigClaudeSeatMaterialSchema: Migration = {
  name: "098_rig_claude_seat_material.sql",
  sql: `
    ALTER TABLE rigs ADD COLUMN claude_seat_material TEXT;
  `,
};
