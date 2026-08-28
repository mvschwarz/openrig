import type { Migration } from "../migrate.js";

/** Durable state for the transcript-byte watchdog condition. */
export const contextUsageWatchdogSchema: Migration = {
  name: "074_context_usage_watchdog.sql",
  sql: `
    ALTER TABLE watchdog_jobs ADD COLUMN watched_file_path TEXT;
    ALTER TABLE watchdog_jobs ADD COLUMN threshold_bytes INTEGER;
    ALTER TABLE watchdog_jobs ADD COLUMN requires_job_id TEXT;
    ALTER TABLE watchdog_jobs ADD COLUMN last_fired_generation_uuid TEXT;
  `,
};
