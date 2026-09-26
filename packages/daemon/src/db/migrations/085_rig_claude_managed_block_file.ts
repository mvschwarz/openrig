import type { Migration } from "../migrate.js";

/**
 * #25 — rigs.claude_managed_block_file column.
 *
 * Holds the rig-level `managed_blocks.claude-code` selection (`CLAUDE.md` or
 * `CLAUDE.local.md`), written by RigRepository.setRigClaudeManagedBlockFile at
 * instantiate time. Startup delivery, teardown and export read it back, so
 * launch, restore replay, relaunch and added members write the same file.
 * Handover writes no guidance; the successor reads the existing file.
 * NULL = the CLAUDE.md default. Mirrors migration 056 (rigs.permission_policy).
 */
export const rigClaudeManagedBlockFileSchema: Migration = {
  name: "085_rig_claude_managed_block_file.sql",
  sql: `
    ALTER TABLE rigs ADD COLUMN claude_managed_block_file TEXT;
  `,
};
