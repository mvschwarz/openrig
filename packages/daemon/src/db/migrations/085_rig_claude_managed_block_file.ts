import type { Migration } from "../migrate.js";

/**
 * #25 — rigs.claude_managed_block_file column.
 *
 * Holds the rig-level `managed_blocks.claude-code` selection (`CLAUDE.md` or
 * `CLAUDE.local.md`), written by RigRepository.setRigClaudeManagedBlockFile at
 * instantiate time. Every startup delivery, teardown and export reads it back,
 * so launch, restore, relaunch, handover and expand all use the same file.
 * NULL = the CLAUDE.md default. Mirrors migration 056 (rigs.permission_policy).
 */
export const rigClaudeManagedBlockFileSchema: Migration = {
  name: "085_rig_claude_managed_block_file.sql",
  sql: `
    ALTER TABLE rigs ADD COLUMN claude_managed_block_file TEXT;
  `,
};
