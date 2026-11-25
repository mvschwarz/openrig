import type { Migration } from "../migrate.js";

export const networkBindingProvidersSchema: Migration = {
  name: "191_network_binding_providers.sql",
  sql: `
    ALTER TABLE network_bindings ADD COLUMN provider_json TEXT;
    ALTER TABLE network_bindings ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE network_bindings ADD COLUMN removal_revision TEXT;
    ALTER TABLE network_bindings ADD COLUMN credential_cleanup_pending INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE network_binding_removals (
      binding_id TEXT NOT NULL,
      credential_revision INTEGER NOT NULL,
      removal_revision TEXT NOT NULL,
      provider_json TEXT NOT NULL,
      hub_url TEXT NOT NULL,
      hub_seat TEXT NOT NULL,
      has_capability INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','confirmed','unconfirmed','superseded')),
      reason TEXT,
      receipt_json TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (binding_id, credential_revision)
    );
    CREATE INDEX idx_network_binding_removals_due ON network_binding_removals(status, next_attempt_at);
  `,
};
