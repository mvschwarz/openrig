import type { Migration } from "../migrate.js";

/**
 * Queue erasure (closed-work retention and account deletion). `content_erased_at` marks a row whose content was
 * removed: the row stays, without content, so a retried create with its id still finds it and makes no new work.
 * A deleted row leaves only its id in `queue_erased_ids`, with no endpoints and no content, and the create path
 * refuses that id (`qitem_erased`). `queue_erased_rigs` keeps an account rig's id and name with a digest of the
 * membership it was verified against, so the run after the rig is removed still erases and counts its records exactly.
 * Once nothing of the rig is left, the record becomes a completion receipt (`completed_at` set, the name cleared), so an
 * identical rerun still verifies and reports the same result.
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
    CREATE TABLE IF NOT EXISTS queue_erased_rigs (
      rig_id TEXT PRIMARY KEY,
      rig_name TEXT NOT NULL,
      members_digest TEXT NOT NULL,
      verified_at TEXT NOT NULL,
      completed_at TEXT
    );
  `,
};
