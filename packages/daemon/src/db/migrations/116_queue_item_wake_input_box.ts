import type { Migration } from "../migrate.js";

// #1278: the input-box reading the transport returned for the row's latest wake attempt, as JSON
// ({ seat, before, after, sameProcess }). Diagnostic only, written with last_nudge_attempt and
// last_nudge_result on every attempt; NULL when that attempt had no reading. Nullable, no backfill.
export const queueItemWakeInputBoxSchema: Migration = {
  name: "116_queue_item_wake_input_box.sql",
  sql: "ALTER TABLE queue_items ADD COLUMN last_nudge_input_box TEXT;",
};
