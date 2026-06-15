import type Database from "better-sqlite3";
import type { NodeLifecycleState, RigLifecycleState } from "./types.js";
import { getNodeInventory } from "./node-inventory.js";
import { archiveWhereClause, type RigArchiveFilter } from "./rig-repository.js";
import type { SeatActivityService } from "./seat-activity-service.js";

export interface PsEntry {
  rigId: string;
  name: string;
  /**
   * Alias of `name`. Always populated and always equal to `name`.
   *
   * Background: per-node `NodeInventoryEntry` exposes the rig's name as
   * `rigName` while rig-summary `PsEntry` historically used `name`. Agent
   * code that projects `.rigName` from rig-summary JSON saw silent
   * `null`/`undefined`. This alias closes that inconsistency without
   * breaking existing consumers reading `.name`.
   */
  rigName: string;
  nodeCount: number;
  runningCount: number;
  /**
   * Slice 15 — count of nodes whose `terminal-active` primitive
   * reports `isActiveWithinWindow === true`. PARALLEL to `runningCount`
   * (which stays `process-alive` semantics). Sourced exclusively from
   * the SeatActivityService; never from queue/assignment state.
   */
  activeCount: number;
  /**
   * Slice 15 — count of nodes whose `has-work-to-do` primitive reports
   * `hasAssignedWork === true`. Derived from the pending queue items
   * with `destination_session` matching the node's canonical session
   * name. Independent from `activeCount` (non-inference contract).
   */
  hasWorkCount: number;
  status: "running" | "partial" | "stopped";
  /** Always populated. Folded from per-node `lifecycleState` (post-L2);
   * empty rigs derive `stopped`. Never undefined or null. */
  lifecycleState: RigLifecycleState;
  uptime: string | null;
  latestSnapshot: string | null;
  /** OPR.0.3.3.19 - ISO timestamp when the rig was archived, or null if active. */
  archivedAt: string | null;
  /** OPR.0.3.3.19 - convenience flag; true iff `archivedAt !== null`. */
  isArchived: boolean;
  /** OPR.0.3.4.9 — periodic snapshot floor: whether the scheduler is active. */
  periodicSnapshotActive: boolean;
  /** OPR.0.3.4.9 — periodic snapshot interval in seconds (0 if inactive). */
  periodicSnapshotIntervalSeconds: number;
  /** OPR.0.3.4.9 — count of auto-periodic snapshots for this rig. */
  autoPeriodicSnapshotCount: number;
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
  private readonly seatActivity: SeatActivityService | null;
  private periodicSnapshotActive = false;
  private periodicSnapshotIntervalSeconds = 0;

  constructor(deps: { db: Database.Database; seatActivity?: SeatActivityService }) {
    this.db = deps.db;
    this.seatActivity = deps.seatActivity ?? null;
  }

  setPeriodicSnapshotState(active: boolean, intervalSeconds: number): void {
    this.periodicSnapshotActive = active;
    this.periodicSnapshotIntervalSeconds = intervalSeconds;
  }

  getEntries(filter?: RigArchiveFilter): PsEntry[] {
    // OPR.0.3.3.19 - default excludes archived rigs at the projection layer
    // (NOT client-side). Explicit includeArchived/archivedOnly opt in.
    const cond = archiveWhereClause("r.archived_at", filter);
    const where = cond ? `WHERE ${cond}` : "";
    const rows = this.db.prepare(`
      SELECT
        r.id as rig_id,
        r.name,
        r.archived_at as archived_at,
        (SELECT COUNT(*) FROM nodes n WHERE n.rig_id = r.id) as node_count,
        (SELECT COUNT(*) FROM nodes n WHERE n.rig_id = r.id AND
          (SELECT status FROM sessions s WHERE s.node_id = n.id ORDER BY s.created_at DESC, s.id DESC LIMIT 1) = 'running'
        ) as running_count,
        (SELECT MIN(s.created_at) FROM sessions s
          JOIN nodes n ON n.id = s.node_id
          WHERE n.rig_id = r.id AND s.status = 'running'
          AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = s.node_id ORDER BY s2.created_at DESC, s2.id DESC LIMIT 1)
        ) as earliest_running_at,
        (SELECT snap.created_at FROM snapshots snap WHERE snap.rig_id = r.id ORDER BY snap.created_at DESC, snap.id DESC LIMIT 1) as latest_snapshot_at,
        (SELECT COUNT(*) FROM snapshots snap WHERE snap.rig_id = r.id AND snap.kind = 'auto-periodic') as auto_periodic_count
      FROM rigs r
      ${where}
      ORDER BY r.name
    `).all() as Array<{
      rig_id: string;
      name: string;
      archived_at: string | null;
      node_count: number;
      running_count: number;
      earliest_running_at: string | null;
      latest_snapshot_at: string | null;
      auto_periodic_count: number;
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

      // Slice 15 — `terminal-active` count. Subset of running tmux-bound
      // seats whose latest SeatActivity observation says
      // `isActiveWithinWindow === true`. Sourced ONLY from the activity
      // service; never derived from queue state.
      let activeCount = 0;
      if (this.seatActivity) {
        for (const node of inventory) {
          if (node.sessionStatus !== "running") continue;
          if (!node.canonicalSessionName) continue;
          const obs = this.seatActivity.getSeatActivity(node.canonicalSessionName);
          if (obs?.isActiveWithinWindow === true) activeCount++;
        }
      }

      // Slice 15 — `has-work-to-do` count. Subset of nodes with at
      // least one pending qitem whose `destination_session` matches the
      // node's `canonicalSessionName`. Sourced ONLY from the queue
      // projection; never from tmux output.
      const hasWorkCount = countNodesWithPendingWork(this.db, r.rig_id);

      return {
        rigId: r.rig_id,
        name: r.name,
        rigName: r.name,
        nodeCount: r.node_count,
        runningCount: r.running_count,
        activeCount,
        hasWorkCount,
        status,
        lifecycleState,
        uptime: r.earliest_running_at ? formatDuration(now - new Date(r.earliest_running_at + "Z").getTime()) : null,
        latestSnapshot: r.latest_snapshot_at ? formatAge(now - new Date(r.latest_snapshot_at + "Z").getTime()) : null,
        archivedAt: r.archived_at,
        isArchived: r.archived_at !== null,
        periodicSnapshotActive: this.periodicSnapshotActive,
        periodicSnapshotIntervalSeconds: this.periodicSnapshotIntervalSeconds,
        autoPeriodicSnapshotCount: r.auto_periodic_count,
      };
    });
  }
}

/**
 * Slice 15 — count nodes in this rig that have at least one pending
 * qitem assigned to them (queue.destination_session matches a node's
 * latest session_name). Pure SQL query — does NOT consult tmux output
 * or SeatActivity (non-inference contract).
 */
function countNodesWithPendingWork(db: Database.Database, rigId: string): number {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT n.id) as c
    FROM nodes n
    JOIN sessions s ON s.node_id = n.id
      AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
    WHERE n.rig_id = ?
      AND EXISTS (
        SELECT 1 FROM queue_items q
        WHERE q.destination_session = s.session_name
          AND q.state = 'pending'
      )
  `).get(rigId) as { c: number } | undefined;
  return row?.c ?? 0;
}

/**
 * Slice 15 — count of pending qitems assigned to a specific canonical
 * session name. Exposed for per-node enrichment in node-inventory.
 */
export function countPendingWorkForSession(db: Database.Database, canonicalSessionName: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) as c FROM queue_items
    WHERE destination_session = ? AND state = 'pending'
  `).get(canonicalSessionName) as { c: number } | undefined;
  return row?.c ?? 0;
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
