import type Database from "better-sqlite3";
import type { NodeLifecycleState, RigLifecycleState } from "./types.js";
import { getNodeInventory } from "./node-inventory.js";

export interface PsEntry {
  rigId: string;
  name: string;
  nodeCount: number;
  runningCount: number;
  status: "running" | "partial" | "stopped";
  lifecycleState: RigLifecycleState;
  uptime: string | null;
  latestSnapshot: string | null;
}

/**
 * Folds per-node lifecycle states into a rig-level lifecycle state.
 *
 *   attention_required > running > recoverable > stopped, with `degraded` for mixes.
 *
 * Rules (post-L2):
 *   - any node attention_required          → attention_required (priority over below).
 *   - all nodes running                    → running.
 *   - all nodes non-running, any recoverable → recoverable.
 *   - all nodes non-running, none recoverable → stopped.
 *   - mixed running + non-running          → degraded.
 *   - empty rig (no nodes)                 → stopped.
 *
 * `recoverable` at rig level depends on per-node recoverability, which already accounts
 * for whether the rig's latest usable snapshot has a resume token for that node.
 */
export function deriveRigLifecycleState(nodeStates: NodeLifecycleState[]): RigLifecycleState {
  if (nodeStates.length === 0) return "stopped";
  if (nodeStates.some((s) => s === "attention_required")) return "attention_required";

  const runningCount = nodeStates.filter((s) => s === "running").length;
  const totalCount = nodeStates.length;

  if (runningCount === totalCount) return "running";
  if (runningCount === 0) {
    const anyRecoverable = nodeStates.some((s) => s === "recoverable");
    return anyRecoverable ? "recoverable" : "stopped";
  }
  return "degraded";
}

/**
 * Projects rig/run summary for `rig ps`.
 * Aggregates across all rigs: node counts, running counts, status, uptime, snapshot age.
 */
export class PsProjectionService {
  readonly db: Database.Database;

  constructor(deps: { db: Database.Database }) {
    this.db = deps.db;
  }

  getEntries(): PsEntry[] {
    const rows = this.db.prepare(`
      SELECT
        r.id as rig_id,
        r.name,
        (SELECT COUNT(*) FROM nodes n WHERE n.rig_id = r.id) as node_count,
        (SELECT COUNT(*) FROM nodes n WHERE n.rig_id = r.id AND
          (SELECT status FROM sessions s WHERE s.node_id = n.id ORDER BY s.created_at DESC, s.id DESC LIMIT 1) = 'running'
        ) as running_count,
        (SELECT MIN(s.created_at) FROM sessions s
          JOIN nodes n ON n.id = s.node_id
          WHERE n.rig_id = r.id AND s.status = 'running'
          AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = s.node_id ORDER BY s2.created_at DESC, s2.id DESC LIMIT 1)
        ) as earliest_running_at,
        (SELECT snap.created_at FROM snapshots snap WHERE snap.rig_id = r.id ORDER BY snap.created_at DESC, snap.id DESC LIMIT 1) as latest_snapshot_at
      FROM rigs r
      ORDER BY r.name
    `).all() as Array<{
      rig_id: string;
      name: string;
      node_count: number;
      running_count: number;
      earliest_running_at: string | null;
      latest_snapshot_at: string | null;
    }>;

    const now = Date.now();

    return rows.map((r) => {
      const status: PsEntry["status"] =
        r.node_count === 0 ? "stopped"
        : r.running_count === r.node_count ? "running"
        : r.running_count > 0 ? "partial"
        : "stopped";

      // Derive rig-level lifecycleState by folding per-node states. The cost is one
      // node-inventory pass per rig; this matches the v0 "derive, no migration" decision.
      const inventory = getNodeInventory(this.db, r.rig_id);
      const lifecycleState = deriveRigLifecycleState(inventory.map((e) => e.lifecycleState));

      return {
        rigId: r.rig_id,
        name: r.name,
        nodeCount: r.node_count,
        runningCount: r.running_count,
        status,
        lifecycleState,
        uptime: r.earliest_running_at ? formatDuration(now - new Date(r.earliest_running_at + "Z").getTime()) : null,
        latestSnapshot: r.latest_snapshot_at ? formatAge(now - new Date(r.latest_snapshot_at + "Z").getTime()) : null,
      };
    });
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${remainMinutes}m`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return `${days}d ${remainHours}h`;
}

function formatAge(ms: number): string {
  const dur = formatDuration(ms);
  return `${dur} ago`;
}
