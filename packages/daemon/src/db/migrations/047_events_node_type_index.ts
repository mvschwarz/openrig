import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.3 hotfix — events per-node/per-rig+type indexes (daemon /healthz-wedge cure).
 *
 * ROOT CAUSE (root-caused from a live CPU sample of the wedged daemon, 98-100%
 * CPU): `GET /api/ps` (polled every 3s by the UI) runs a two-level nested map
 * (ps-projection over rigs -> getNodeInventory -> node-inventory over nodes)
 * whose per-node derivations reverse-scan the append-only `events` table with
 * NO supporting index. The only pre-existing index is
 * `idx_events_rig_seq(rig_id, seq)` — nothing leads with `node_id`, and no
 * index makes the `type` filter selective. So:
 *   - `deriveOriented` (startup-proof.ts): `WHERE node_id=? AND type IN (...)
 *     ORDER BY seq DESC` had NO usable index -> a full backward PK-btree walk
 *     of the WHOLE events log, per node, every 3s (the btreePrevious/pread
 *     signature in the sample). This is the primary wedge.
 *   - `deriveRestoreOutcome` (node-inventory.ts): `WHERE rig_id=? AND type IN
 *     ('restore.*') ORDER BY seq DESC` rode `idx_events_rig_seq` but, with
 *     `type` unindexed, walked ALL of the rig's events (incl. high-volume
 *     `agent.activity`) in reverse to find the latest restore event.
 *   - `getLatestForNode` (agent-activity-store.ts) + `deriveHeldReason`'s
 *     `node.held` lookup are the same `node_id`-filtered reverse pattern.
 * The `events` table is append-only with zero prune (survives rig/node
 * deletion for audit), so it grows forever and each scan lengthens until the
 * single-threaded better-sqlite3 loop starves `/healthz`.
 *
 * FIX (additive, index-only — no data change): the covering index that turns
 * the primary wedge's reverse walk into a bounded index seek over only the
 * relevant (node_id, type) partition instead of the whole log.
 *   - idx_events_node_type_seq (node_id, type, seq) — serves the PRIMARY wedge
 *     `deriveOriented` (node_id + type filtered, ORDER BY seq DESC — previously
 *     UNINDEXED → the full-table reverse scan in the CPU sample), plus
 *     `getLatestForNode` and `deriveHeldReason`'s node.held lookup (same
 *     node_id + type reverse pattern).
 * `deriveRestoreOutcome` (rig_id + type filtered) is NOT addressed here: it
 * already rides the existing `idx_events_rig_seq(rig_id, seq)` (the SQLite
 * planner prefers it because it satisfies ORDER BY seq DESC with no sort; a
 * (rig_id, type, seq) index would go UNUSED — verified via EXPLAIN QUERY PLAN),
 * so it is rig-bounded (not the full-table wedge) — a second-order cost the
 * per-node N+1 collapse (a single per-rig windowed query) addresses as the
 * separate, gated follow-on. An agent.activity retention/prune is the other
 * gated follow-on. Neither is in this hotfix.
 * CREATE INDEX IF NOT EXISTS is idempotent + safe to apply to a live/populated
 * events table (SQLite builds the index in one pass; no schema/data rewrite).
 *
 * Next free number after 046_seat_identity_verdicts.ts.
 */
export const eventsNodeTypeIndexSchema: Migration = {
  name: "047_events_node_type_index.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_events_node_type_seq ON events(node_id, type, seq);
  `,
};
