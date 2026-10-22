import type { Migration } from "../migrate.js";

/** Issue #1180 — per-watchdog token and percent-of-window threshold units. */
export const contextUsageWatchdogUnitsSchema: Migration = {
  name: "124_context_usage_watchdog_units.sql",
  sql: `
    ALTER TABLE watchdog_jobs ADD COLUMN threshold_tokens INTEGER;
    ALTER TABLE watchdog_jobs ADD COLUMN threshold_percent REAL;
  `,
};
