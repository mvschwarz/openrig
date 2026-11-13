import type { Migration } from "../migrate.js";

/**
 * Queue-driven seat cold start (#2829 slice 1): one row per seat that records the
 * cold-start attempt ledger — the coalescing and failure backoff state for launching
 * a dormant opted-in seat's runner when queued work targets it. `last_success_at`
 * resets the consecutive-failure count; a seat with no row has never been cold-started.
 */
export const seatColdStartsSchema: Migration = {
  name: "158_seat_cold_starts.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS seat_cold_starts (
      node_id TEXT PRIMARY KEY,
      last_attempt_at TEXT NOT NULL,
      last_outcome TEXT NOT NULL,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_success_at TEXT
    );
  `,
};
