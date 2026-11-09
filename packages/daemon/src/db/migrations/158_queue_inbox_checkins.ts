import type { Migration } from "../migrate.js";

/**
 * When each session last read its own pending inbox (the queue list route records it). The stuck sweep reads it to say
 * whether a hosted member that picks up work by polling is checking in. It's availability only: never a receipt, a claim
 * or an answer for any row. Session names and times only, no content.
 */
export const queueInboxCheckinsSchema: Migration = {
  name: "158_queue_inbox_checkins.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS queue_inbox_checkins (
      session TEXT PRIMARY KEY,
      checked_at TEXT NOT NULL
    );
  `,
};
