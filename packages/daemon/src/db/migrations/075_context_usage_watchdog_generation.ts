import type { Migration } from "../migrate.js";

/** Qualifies a persisted transcript path with the occupant generation that supplied it. */
export const contextUsageWatchdogGenerationSchema: Migration = {
  name: "075_context_usage_watchdog_generation.sql",
  sql: `
    ALTER TABLE watchdog_jobs ADD COLUMN watched_file_generation_uuid TEXT;
  `,
};
