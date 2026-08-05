import type { Migration } from "../migrate.js";

/**
 * 51-09 increment 1 — the durable daemon SELF-HOST identity record.
 *
 * Arch ruling cb19867f (Q1): canonical self-host identity is NET-NEW — there is
 * no authoritative self-record today, only a display-only `host.name`
 * (settings), the positional `"local"` sentinel (fanout-contract), and the host
 * registry's labels-others-assign-me. This table is the daemon's own
 * authoritative, durable, stable-across-restart self-host id, reconciled AT BOOT
 * beside the seat-identity substrate (slice-13 reconcile lineage).
 *
 * Singleton: exactly one row (`singleton = 1` CHECK). `host_id` is MINTED once on
 * first boot and thereafter RECONCILED (never re-minted) — restart ⇒ same id.
 * `minted_at` never moves; `reconciled_at` advances every boot. The id is never
 * the `"local"`/`"kernel"`/`"host"` reserved set nor the `"localhost"` display
 * default (asserted in the reconciler). Next free number after
 * 058_rig_policy_provenance.ts.
 */
export const selfHostIdentitySchema: Migration = {
  name: "059_self_host_identity.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS self_host_identity (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      host_id TEXT NOT NULL,
      minted_at TEXT NOT NULL,
      reconciled_at TEXT NOT NULL
    );
  `,
};
