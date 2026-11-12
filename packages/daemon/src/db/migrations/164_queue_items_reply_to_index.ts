import type { Migration } from "../migrate.js";

/** An ask's answers and its decision revision find rows by their `reply_to`. Without this, each lookup scans the whole
 *  queue, once per request on the attention read. Partial: only replies carry the column. */
export const queueItemsReplyToIndexSchema: Migration = {
  name: "164_queue_items_reply_to_index.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_queue_items_reply_to ON queue_items(reply_to) WHERE reply_to IS NOT NULL;
  `,
};
