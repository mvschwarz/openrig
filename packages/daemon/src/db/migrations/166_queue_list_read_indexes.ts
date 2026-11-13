import type { Migration } from "../migrate.js";

/** Bound queue selection by its existing order, and notification reads by their eligible history. */
export const queueListReadIndexesSchema: Migration = {
  name: "166_queue_list_read_indexes.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_queue_items_created
      ON queue_items(ts_created DESC);
    CREATE INDEX IF NOT EXISTS idx_queue_items_active_created
      ON queue_items(CASE WHEN state IN ('pending', 'in-progress', 'blocked') THEN 0 ELSE 1 END, ts_created DESC);
    CREATE INDEX IF NOT EXISTS idx_queue_items_active_updated
      ON queue_items(CASE WHEN state IN ('pending', 'in-progress', 'blocked') THEN 0 ELSE 1 END, ts_updated DESC);
    CREATE INDEX IF NOT EXISTS idx_queue_transitions_owner_notification_qitem
      ON queue_transitions(qitem_id, transition_id DESC) WHERE owner_notification_level IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_queue_transitions_archive_owner_notification_qitem
      ON queue_transitions_archive(qitem_id, transition_id DESC) WHERE owner_notification_level IS NOT NULL;
  `,
};
