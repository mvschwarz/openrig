import type { Migration } from "../migrate.js";

/**
 * Inbox entries (PL-004 Phase A; mailbox-style asynchronous deposit).
 *
 * Per founder-resolved direction: inbox is the canonical async/bulk path,
 * NOT a contention fallback. Any authenticated sender may inbox-drop with
 * attribution + audit. Receiver chooses absorb (promote to main queue) or
 * deny (reject with reason). Idempotent on inbox_id.
 *
 * State enum: pending | absorbed | denied
 * `absorbed_qitem_id` records which queue_item the absorbed entry became.
 */
export const inboxEntriesSchema: Migration = {
  name: "026_inbox_entries.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS inbox_entries (
      inbox_id TEXT PRIMARY KEY,
      destination_session TEXT NOT NULL,
      sender_session TEXT NOT NULL,
      body TEXT NOT NULL,
      tags TEXT,
      urgency TEXT NOT NULL DEFAULT 'routine',
      ts_dropped TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      absorbed_at TEXT,
      absorbed_qitem_id TEXT,
      denied_at TEXT,
      denied_reason TEXT,
      audit_pointer TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_entries_destination_state ON inbox_entries(destination_session, state);
    CREATE INDEX IF NOT EXISTS idx_inbox_entries_sender ON inbox_entries(sender_session);
    CREATE INDEX IF NOT EXISTS idx_inbox_entries_state ON inbox_entries(state);
  `,
};
