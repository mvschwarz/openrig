import type { Migration } from "../migrate.js";

/** A request's related rows (`relatedTo`, the core app's graph read) are matched by `reply_to`, `handed_off_from` or
 *  `blocked_on` in one OR. The first two have indexes; without one here, the OR scans the whole queue, once per node of
 *  a graph read. Partial: only rows naming a blocker carry the column. A row keeps it after a handoff or a cross-host
 *  close, so the index covers every row that names one, not only blocked rows. */
export const queueItemsBlockedOnIndexSchema: Migration = {
  name: "182_queue_items_blocked_on_index.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_queue_items_blocked_on ON queue_items(blocked_on) WHERE blocked_on IS NOT NULL;
  `,
};
