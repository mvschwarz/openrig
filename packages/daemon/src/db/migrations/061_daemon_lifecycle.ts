import type { Migration } from "../migrate.js";

/**
 * P7 shutdown-record — the daemon's own LIFECYCLE record (started / last-seen /
 * stopped), distinct from the identity record (059 self_host_identity).
 *
 * Arch verdict d6a6c1db (FLAG-1): NET-NEW own table, NOT columns on
 * self_host_identity — identity vs lifecycle is a type + write-cadence
 * separation (a hot heartbeat UPDATE every tick must not churn the identity
 * row image that alignment asserts + gateway reads consult). One home per
 * concern. (Number: 060 was next-free at ruling time but claimed in flight by
 * the tenure-ledger lane; P7 takes 061 — the own-table semantics are the ruling,
 * the number is incidental. Next free after 059_self_host_identity /
 * 060_<tenure-ledger>.)
 *
 * Singleton with a boot_epoch: a new boot mints a new epoch, sets started_at,
 * and CLEARS stopped_at; the heartbeat advances last_heartbeat_at while
 * not-stopped; a clean shutdown sets stopped_at (terminal per epoch). The render
 * epoch-guards so a stale prior-run stopped_at is never shown for the new epoch.
 * Row-per-epoch history is a builder option; the minimum is this singleton.
 */
export const daemonLifecycleSchema: Migration = {
  name: "061_daemon_lifecycle.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS daemon_lifecycle (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      boot_epoch TEXT NOT NULL,
      started_at TEXT NOT NULL,
      last_heartbeat_at TEXT,
      stopped_at TEXT
    );
  `,
};
