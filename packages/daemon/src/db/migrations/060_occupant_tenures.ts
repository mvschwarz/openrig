import type { Migration } from "../migrate.js";

// GHOST-STAGE atom-B (P12 verdict 3548d8eb): the occupant-generation TENURE ledger.
//
// A `sessions` row is a REGISTRATION, not a tenure — treating a row as a generation mints PHANTOM
// generations. This append-only ledger records ONE row per OCCUPANT GENERATION on a node, minted in
// the registry at registerSession / registerClaimedSession (callers declare `kind`). `generation_uuid`
// is the STABLE occupant identity that survives handover/swap/repair (the provider's native session id
// is a separate POINTER — the 51-09 split); consumers compare it to gate stale-generation state
// (the ghost-stage defect). node_id is stable across handover/swap/repair.
//
// HONEST BOUNDARY: node_id does NOT survive a `rig` teardown-recreate of the node — out of scope for
// this ledger (a recreated node is a genuinely new identity), and labelled here so no consumer assumes
// cross-teardown continuity.
export const occupantTenuresSchema: Migration = {
  name: "060_occupant_tenures.sql",
  sql: `
    CREATE TABLE occupant_tenures (
      id                        TEXT PRIMARY KEY,
      node_id                   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      generation_ordinal        INTEGER NOT NULL,
      generation_uuid           TEXT NOT NULL UNIQUE,
      kind                      TEXT NOT NULL,
      native_session_id_at_boot TEXT,
      boot_at                   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(node_id, generation_ordinal)
    );
    CREATE INDEX idx_occupant_tenures_node ON occupant_tenures(node_id);
  `,
};
