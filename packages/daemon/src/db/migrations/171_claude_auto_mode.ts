import type { Migration } from "../migrate.js";

/** A seat's saved Claude autoMode block, and the block each managed launch actually composed into --settings. */
export const claudeAutoModeSchema: Migration = {
  name: "171_claude_auto_mode.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN claude_auto_mode_json TEXT;
    ALTER TABLE applied_launch_observations ADD COLUMN claude_auto_mode_json TEXT;
  `,
};
