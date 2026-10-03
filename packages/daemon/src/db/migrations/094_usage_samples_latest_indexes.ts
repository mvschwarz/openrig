import type { Migration } from "../migrate.js";

// Dedup compares the last inserted observation, even when the wall clock moves
// backwards. Keep that id order; each lane needs its own equality-prefix index.
export const usageSamplesLatestIndexesSchema: Migration = {
  name: "094_usage_samples_latest_indexes.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_usage_samples_context_latest
      ON usage_samples(seat_session, id) WHERE lane = 'context';
    CREATE INDEX IF NOT EXISTS idx_usage_samples_window_latest
      ON usage_samples(seat_session, window, id) WHERE lane = 'provider_window';
  `,
};
