import type { Migration } from "../migrate.js";

/** A handed-off row's successor is found by its `handed_off_from` (`rig queue show`, the follow-through read). Without
 *  this, each lookup scans the whole queue. Partial: only successor rows carry the column. */
export const queueItemsHandedOffFromIndexSchema: Migration = {
  name: "159_queue_items_handed_off_from_index.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_queue_items_handed_off_from ON queue_items(handed_off_from) WHERE handed_off_from IS NOT NULL;
  `,
};
