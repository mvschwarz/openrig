import type { Migration } from "../migrate.js";

export const seatDeliveryGuardSchema: Migration = {
  name: "087_seat_delivery_guard.sql",
  sql: `
    CREATE TABLE seat_delivery_guards (
      node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      desired INTEGER NOT NULL CHECK (desired IN (0,1)),
      effective INTEGER NOT NULL CHECK (effective IN (0,1)),
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      changed_at TEXT NOT NULL
    );
    CREATE TABLE seat_delivery_guard_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id TEXT NOT NULL,
      desired INTEGER NOT NULL,
      previous_desired INTEGER NOT NULL,
      previous_effective INTEGER NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      effective_at TEXT
    );
    ALTER TABLE outbox_entries ADD COLUMN guard_binding TEXT;
    ALTER TABLE outbox_entries ADD COLUMN retired_at TEXT;
    ALTER TABLE outbox_entries ADD COLUMN retired_by TEXT;
    ALTER TABLE outbox_entries ADD COLUMN retirement_reason TEXT;
    CREATE INDEX idx_outbox_guard_active ON outbox_entries(destination_session, delivery_state)
      WHERE delivery_state = 'retained';
  `,
};
