import type { Migration } from "../migrate.js";

/**
 * Outbox entries (PL-004 Phase A; symmetric to inbox).
 *
 * Sender-side audit of dispatched items. Useful for senders that want a
 * record of sent items independent of receiver behavior. Daemon-managed
 * write; idempotent on outbox_id.
 *
 * delivery_state enum: pending | delivered | failed
 */
export const outboxEntriesSchema: Migration = {
  name: "027_outbox_entries.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS outbox_entries (
      outbox_id TEXT PRIMARY KEY,
      sender_session TEXT NOT NULL,
      destination_session TEXT NOT NULL,
      body TEXT NOT NULL,
      tags TEXT,
      urgency TEXT NOT NULL DEFAULT 'routine',
      ts_dispatched TEXT NOT NULL,
      delivery_state TEXT NOT NULL DEFAULT 'pending',
      delivered_at TEXT,
      audit_pointer TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_entries_sender ON outbox_entries(sender_session);
    CREATE INDEX IF NOT EXISTS idx_outbox_entries_destination ON outbox_entries(destination_session);
    CREATE INDEX IF NOT EXISTS idx_outbox_entries_delivery_state ON outbox_entries(delivery_state);
  `,
};
