import type { Migration } from "../migrate.js";

/**
 * Queue erasure (closed-work retention and account deletion). `content_erased_at` marks a row whose content was
 * removed: the row stays, without content, so a retried create with its id still finds it and makes no new work.
 * A deleted row leaves only its id in `queue_erased_ids`, with no endpoints and no content, and the create path
 * refuses that id (`qitem_erased`).
 */
export const queueErasureSchema: Migration = {
  name: "155_queue_erasure.sql",
  sql: `
    ALTER TABLE queue_items ADD COLUMN content_erased_at TEXT;
    CREATE TABLE IF NOT EXISTS queue_erased_ids (
      qitem_id TEXT PRIMARY KEY,
      erased_at TEXT NOT NULL,
      reason TEXT NOT NULL
    );
  `,
};
