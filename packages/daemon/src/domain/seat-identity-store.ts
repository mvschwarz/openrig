import type Database from "better-sqlite3";
import type { SeatIdentityVerdict } from "./types.js";

interface VerdictRow {
  node_id: string;
  verdict: string;
  evidence_source: string | null;
  reason: string | null;
  registered_pane: string | null;
  observed_pid: number | null;
  observed_command: string | null;
  matched_layer: number | null;
  session_name: string | null;
  observed_at: string;
}

function rowToVerdict(row: VerdictRow): SeatIdentityVerdict {
  return {
    nodeId: row.node_id,
    verdict: row.verdict as SeatIdentityVerdict["verdict"],
    evidenceSource: row.evidence_source as SeatIdentityVerdict["evidenceSource"],
    reason: row.reason as SeatIdentityVerdict["reason"],
    evidence: {
      registeredPane: row.registered_pane,
      observedPid: row.observed_pid,
      observedCommand: row.observed_command,
      matchedLayer: row.matched_layer,
    },
    sessionName: row.session_name,
    observedAt: row.observed_at,
  };
}

/**
 * OPR.0.4.3.19 — explicit, durable store for the per-node liveness identity
 * verdict (migration 046 `seat_identity_verdicts`). The reconciler writes;
 * node-inventory reads. Kept as a thin, stateless wrapper over the table so
 * the liveness truth lives in the DB, never in transient in-memory state
 * (dev-guard plan-review caveat).
 *
 * Reads are DEFENSIVE: fixtures that bypass the canonical migration list (no
 * `seat_identity_verdicts` table) get an empty map/undefined rather than a
 * crash — the projection degrades to "no verdict" (never down-ranks), matching
 * the fail-open-on-unknown contract.
 */
export class SeatIdentityStore {
  constructor(private readonly db: Database.Database) {}

  /** Upsert one node's verdict (last-writer-wins per node). */
  upsert(v: SeatIdentityVerdict): void {
    this.db.prepare(`
      INSERT INTO seat_identity_verdicts
        (node_id, verdict, evidence_source, reason, registered_pane, observed_pid, observed_command, matched_layer, session_name, observed_at)
      VALUES (@node_id, @verdict, @evidence_source, @reason, @registered_pane, @observed_pid, @observed_command, @matched_layer, @session_name, @observed_at)
      ON CONFLICT(node_id) DO UPDATE SET
        verdict = excluded.verdict,
        evidence_source = excluded.evidence_source,
        reason = excluded.reason,
        registered_pane = excluded.registered_pane,
        observed_pid = excluded.observed_pid,
        observed_command = excluded.observed_command,
        matched_layer = excluded.matched_layer,
        session_name = excluded.session_name,
        observed_at = excluded.observed_at
    `).run({
      node_id: v.nodeId,
      verdict: v.verdict,
      evidence_source: v.evidenceSource,
      reason: v.reason,
      registered_pane: v.evidence.registeredPane,
      observed_pid: v.evidence.observedPid,
      observed_command: v.evidence.observedCommand,
      matched_layer: v.evidence.matchedLayer,
      session_name: v.sessionName,
      observed_at: v.observedAt,
    });
  }

  /** Read all verdicts for the nodes of a rig, keyed by node_id. Defensive. */
  getForRig(rigId: string): Map<string, SeatIdentityVerdict> {
    const out = new Map<string, SeatIdentityVerdict>();
    try {
      const rows = this.db.prepare(`
        SELECT v.* FROM seat_identity_verdicts v
        JOIN nodes n ON n.id = v.node_id
        WHERE n.rig_id = ?
      `).all(rigId) as VerdictRow[];
      for (const row of rows) out.set(row.node_id, rowToVerdict(row));
    } catch {
      // Table absent (partial fixture) — degrade to no verdicts.
    }
    return out;
  }

  /** Read a single node's verdict, or null. Defensive. */
  getForNode(nodeId: string): SeatIdentityVerdict | null {
    try {
      const row = this.db.prepare(
        "SELECT * FROM seat_identity_verdicts WHERE node_id = ?",
      ).get(nodeId) as VerdictRow | undefined;
      return row ? rowToVerdict(row) : null;
    } catch {
      return null;
    }
  }

  /** Drop verdicts for nodes no longer in the live set (memory/table hygiene). */
  pruneExcept(liveNodeIds: string[]): void {
    try {
      const existing = this.db.prepare(
        "SELECT node_id FROM seat_identity_verdicts",
      ).all() as Array<{ node_id: string }>;
      const live = new Set(liveNodeIds);
      const del = this.db.prepare("DELETE FROM seat_identity_verdicts WHERE node_id = ?");
      for (const r of existing) {
        if (!live.has(r.node_id)) del.run(r.node_id);
      }
    } catch {
      // Table absent — nothing to prune.
    }
  }
}
