import type { Migration } from "../migrate.js";

/** An operator's recorded runtime home for an existing seat: one row per applied correction, with the occupant and
 *  original conversation it was recorded against, a per-seat revision, and the operation id that makes a retry safe. */
export const seatRuntimeHomeRecordsSchema: Migration = {
  name: "169_seat_runtime_home_records.sql",
  sql: `
    CREATE TABLE seat_runtime_home_records (
      operation_id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      runtime TEXT NOT NULL,
      revision INTEGER NOT NULL,
      home TEXT NOT NULL,
      slot TEXT NOT NULL CHECK (slot IN ('account_home', 'member_env')),
      previous_home TEXT,
      previous_source TEXT NOT NULL,
      original TEXT,
      occupant_generation TEXT,
      request_hash TEXT NOT NULL,
      reason TEXT NOT NULL,
      operator TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (node_id, revision)
    );
  `,
};
