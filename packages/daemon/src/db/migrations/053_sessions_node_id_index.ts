import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.6 FS-1 (daemon read-path hardening, W1.1) — sessions per-node recency index.
 *
 * ROOT CAUSE (arch grounding ARCH-DESIGN-GROUNDING-fs1-2026-07-06, F1;
 * re-verified firsthand at 384e60f1): the `sessions` table
 * (002_bindings_sessions.ts) was created with ZERO indexes on `node_id` — its
 * only index is the `id` PRIMARY-KEY autoindex. The "latest session per node"
 * subquery `(SELECT s2.id FROM sessions s2 WHERE s2.node_id = ? ORDER BY … LIMIT 1)`
 * is therefore a FULL SCAN of `sessions`, and it appears PER NODE at THREE sites
 * on the hot `/api/ps` path — multiplied by the rig-level N+1 (getEntries loops
 * rigs), one poll scanned `sessions` many times over (the 0.6-0.9s wedge at the
 * host shape). The three sites, and their ORDER BY (why the index is 3-column):
 *   - ps-projection.ts:157      ORDER BY created_at DESC, id DESC   ← the load-bearing shape
 *   - node-inventory.ts:442     ORDER BY id DESC
 *   - ps-projection.ts:256      ORDER BY id DESC
 *
 * INDEX SHAPE = (node_id, created_at DESC, id DESC) — arch RULING (B), decided
 * by FIXTURE-MEASURED evidence, NOT preference. Measured before/after on the real
 * incident fixture (24 rigs / 175 nodes / 445 sessions) — evidence:
 *   missions/release-0.4.6/slices/01-fs1-daemon-read-path-hardening/proof/
 *   perf-hardening-evidence/W1.1-sessions-index-measure-2026-07-06-dev44-driver2.md
 *   - id-DESC sites (:442, :256): full-scan → covering seek, ~63x (0.677s→0.011s / 52.5k evals).
 *   - created_at site (:157): under a 2-col (node_id, id DESC) index it SEARCHes
 *     node_id but keeps a TEMP B-TREE sort (~18.6x); under THIS 3-col index it is
 *     `SEARCH … USING COVERING INDEX` with NO sort (~95x, 0.856s→0.009s) — the
 *     measured ~5x that decided the shape.
 *   - Bound proven at 10x scale (4450 sessions): full-scan 8.4s (grows with data)
 *     vs seek 0.024s (~flat) = ~350x. CREATE INDEX = 0.013s, safe on populated data.
 * The 3-column index leads with `node_id` (the equality seek), so the two id-DESC
 * sites still get the node_id seek (full-scan eliminated); their residual is a
 * per-node sort over ~2-3 rows (445 sessions / 175 nodes) — arch-accepted as noise.
 * ONE index by ruling: this migration WIDENS to the 3-column shape and never grows
 * a sibling (a second index = write amplification + space for no measured need).
 *
 * CREATE INDEX IF NOT EXISTS is idempotent + safe on a live/populated table
 * (SQLite builds it in one pass; no schema/data change).
 *
 * Sibling audit (arch D1.1): the snapshots(rig_id, created_at) subqueries in the
 * rigs projection are a separate index-audit item in W1, not this migration.
 *
 * Number 053: main shipped 051_workflow_resume and FAC-1 reserves
 * 052_workflow_instance_bound_rig, so FS-1's index migration renumbered
 * 051→053 (orch deconflict 2026-07-06; re-verify the free slot against the
 * final merged tree at rebase/proof time). The index NAME + shape are unchanged.
 */
export const sessionsNodeIdIndexSchema: Migration = {
  name: "053_sessions_node_id_index.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_sessions_node_created_id
      ON sessions(node_id, created_at DESC, id DESC);
  `,
};
