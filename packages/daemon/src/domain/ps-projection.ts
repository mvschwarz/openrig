import type Database from "better-sqlite3";
import type { NodeInventoryEntry, NodeLifecycleState, RigLifecycleState } from "./types.js";
import { identityVerdictConfirmsSessionMissing } from "./types.js";
import {
  countAssignedWorkForEntry,
  seatNeedsAttention,
  arbitratedNeedsInputSignal,
  hookOrPaneActivity,
  getNodeInventoryForAllRigs,
  readAssignedWorkBySession,
  type AssignedWorkCounts,
} from "./node-inventory.js";
import { archiveWhereClause, type RigArchiveFilter } from "./rig-repository.js";
import type { SeatActivityService } from "./seat-activity-service.js";
import type { SeatStructuralActivityService } from "./seat-structural-activity-service.js";
import type { AgentActivityStore } from "./agent-activity-store.js";

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
   * `hasAssignedWork === true`. Derived from active queue items
   * with `destination_session` matching either of the node's canonical
   * coordinates. Independent from `activeCount` (non-inference contract).
   */
  hasWorkCount: number;
  status: "running" | "partial" | "stopped";
  /** Folded from members not explicitly stopped. Empty rigs and rigs whose
   * members are all intentionally stopped derive `stopped`. */
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
  /**
   * OPR.0.4.4.21 — count of seats needing attention (additive field; the
   * consolidated default's ATTENTION flag and the host rollup's "K need
   * attention" both read it). A seat counts ONCE when ANY signal in
   * `seatNeedsAttention` fires. Folded inside the same per-rig inventory
   * pass as `lifecycleState` — no extra probes.
   */
  attentionCount: number;
}

export { seatNeedsAttention, arbitratedNeedsInputSignal } from "./node-inventory.js";

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

/** Shared display rollup for ps and the rig summaries consumed by the TUI.
 * Intentionally stopped seats remain in process counts and node diagnostics. */
export function deriveRigLifecycleFromInventory(
  inventory: readonly Pick<NodeInventoryEntry, "lifecycleState" | "intentionallyStopped">[],
): RigLifecycleState {
  return deriveRigLifecycleState(
    inventory.filter((entry) => !entry.intentionallyStopped).map((entry) => entry.lifecycleState),
  );
}

/**
 * Slice-05 item-5 (D5) — the SINGLE effective-running predicate for the ps
 * running rollup. `sessions.status='running'` alone is verdict-blind: a seat
 * whose tmux session was torn down out-of-band keeps `status='running'` in the
 * DB, so the raw SQL count fabricates a dead seat as running. The
 * SeatIdentityReconciler (and, since Slice-05, the live SessionTransport on a
 * `session_missing` send/capture) records an APPLICABLE `session_missing`
 * verdict for exactly that case; node-inventory already surfaces it here,
 * applicability-gated (a stale verdict is null → fail-open).
 *
 * ONLY `reason === "session_missing"` — a genuinely-gone tmux session — is
 * excluded. `pane_pid_gone` / `mismatch` / `tmux_unavailable` and an absent or
 * inapplicable (null) verdict all stay running: an ambiguous or non-fatal
 * identity signal must never fabricate `stopped` (it down-ranks lifecycle to
 * attention, a separate axis). runningCount, status, and activeCount all flow
 * through this one predicate so the three never contradict each other. This
 * reads the verdict; it NEVER mutates `sessions.status`.
 */
export function isEffectivelyRunning(node: NodeInventoryEntry): boolean {
  if (node.sessionStatus !== "running") return false;
  if (identityVerdictConfirmsSessionMissing(node.identityVerdict)) return false;
  return true;
}

/**
 * Projects rig/run summary for `rig ps`.
 * Aggregates across all rigs: node counts, running counts, status, uptime, snapshot age.
 */
export class PsProjectionService {
  readonly db: Database.Database;
  private readonly seatActivity: SeatActivityService | null;
  /** OPR.0.4.4.21 — synchronous hook-activity lookup for the attention
   *  predicate's `needs_input` signal. Optional: absent → the signal
   *  contributes false (honest degrade), never a guess. */
  private readonly agentActivity: AgentActivityStore | null;
  /** The cached pane reading, so the count sees a prompt only the pane shows, as the seat row does. */
  private readonly structuralActivity: Pick<SeatStructuralActivityService, "getStructuralActivity"> | null;
  private periodicSnapshotActive = false;
  private periodicSnapshotIntervalSeconds = 0;

  constructor(deps: {
    db: Database.Database; seatActivity?: SeatActivityService; agentActivity?: AgentActivityStore;
    structuralActivity?: Pick<SeatStructuralActivityService, "getStructuralActivity">;
  }) {
    this.db = deps.db;
    this.seatActivity = deps.seatActivity ?? null;
    this.agentActivity = deps.agentActivity ?? null;
    this.structuralActivity = deps.structuralActivity ?? null;
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
      latest_snapshot_at: string | null;
      auto_periodic_count: number;
    }>;

    const now = Date.now();

    // FS-1 W1.2 (rig-level N+1 collapse): the assigned-work map is host-global and
    // bounded by distinct destination sessions (seat count), so read it ONCE here
    // instead of one countNodesWithPendingWork query per rig. Per-rig hasWorkCount
    // is then a pure JS derivation over the already-fetched inventory below.
    const assignedByDest = readAssignedWorkBySession(this.db);
    // FS-1 W1.2: node inventory for ALL rigs built in ONE batched pass (was one
    // getNodeInventory query-set PER RIG — the rig-level N+1); indexed per rig below.
    const inventoryByRig = getNodeInventoryForAllRigs(this.db);

    // Read the current registration's timestamp once per node, in one batch.
    // Uptime membership comes from the same effective-running inventory below.
    const sessionTimes = this.db.prepare(`
      SELECT n.id as node_id,
        (SELECT s.created_at FROM sessions s WHERE s.node_id = n.id ORDER BY s.id DESC LIMIT 1) as created_at
      FROM nodes n JOIN rigs r ON r.id = n.rig_id
      ${where}
    `).all() as Array<{ node_id: string; created_at: string | null }>;
    const sessionCreatedAt = new Map(sessionTimes.map((row) => [row.node_id, row.created_at]));

    return rows.map((r) => {
      // Derive rig-level lifecycleState by folding per-node states. FS-1 W1.2:
      // inventory for ALL rigs was built in ONE batched pass above (previously one
      // getNodeInventory query-set per rig — the rig-level N+1); index it here.
      const inventory = inventoryByRig.get(r.rig_id) ?? [];

      // Count the same current registrations used for lifecycle and activity.
      // Registry IDs stay monotonic through clock rollback within one daemon;
      // created_at does not. Reusing inventory also avoids another per-node sort.
      const running = inventory.filter(isEffectivelyRunning);
      const effectiveRunningCount = running.length;
      let earliestRunningAt: string | null = null;
      for (const node of running) {
        const createdAt = sessionCreatedAt.get(node.nodeId);
        if (createdAt != null && (earliestRunningAt === null || createdAt < earliestRunningAt)) earliestRunningAt = createdAt;
      }

      const status: PsEntry["status"] =
        r.node_count === 0 ? "stopped"
        : effectiveRunningCount === r.node_count ? "running"
        : effectiveRunningCount > 0 ? "partial"
        : "stopped";

      const lifecycleState = deriveRigLifecycleFromInventory(inventory);

      // Slice 15 — `terminal-active` count. Subset of running tmux-bound
      // seats whose latest SeatActivity observation says
      // `isActiveWithinWindow === true`. Sourced ONLY from the activity
      // service; never derived from queue state.
      let activeCount = 0;
      if (this.seatActivity) {
        for (const node of inventory) {
          if (!isEffectivelyRunning(node)) continue;
          if (!node.canonicalSessionName) continue;
          const obs = this.seatActivity.getSeatActivity(node.canonicalSessionName);
          if (obs?.isActiveWithinWindow === true) activeCount++;
        }
      }

      // Slice 15 — `has-work-to-do` count. Subset of nodes with at
      // least one pending, in-progress, or blocked qitem whose destination
      // matches either canonical coordinate for the node. Sourced ONLY from the queue
      // projection; never from tmux output.
      // Slice 17: this is the SAME dual-key resolver and active-state map used by
      // per-node inventory. The former single-key/pending-only divergence is gone.
      let hasWorkCount = 0;
      for (const node of inventory) {
        if (countAssignedWorkForEntry(node, assignedByDest).assignedWorkCount > 0) hasWorkCount++;
      }

      // OPR.0.4.4.21 — attention fold, same inventory pass. `needs_input` is
      // read from the ARBITRATED seat state first — the same oracle the
      // per-seat row renders (`activityState` on node-inventory), which also
      // sees pane chrome a hook-silent gated seat never reports. The served
      // activity (the hook store, else the cached pane reading, as the seat row
      // reads it) is the fallback when the arbitrated signal is `null` — service
      // unwired, session not in the ladder, or a `count: 0` that no authoritative
      // needs-input evidence supplied (#180 review; discussion #879); `now` keeps its
      // staleness honest (stale hooks come back `unknown` and contribute
      // nothing). Preferring one source over the other is what let a gated seat
      // show `needs-input x1` on its row while the rig total read ATTN 0.
      let attentionCount = 0;
      const nowDate = new Date(now);
      for (const node of inventory) {
        const session = node.canonicalSessionName;
        const arbitrated = this.seatActivity && session
          && typeof this.seatActivity.getSeatStateBySession === "function"
          ? this.seatActivity.getSeatStateBySession(session)
          : null;
        const hook = this.agentActivity && session
          ? this.agentActivity.getLatestForNode({ sessionName: session, now: nowDate })
          : null;
        // The row's served activity: a live hook, else the cached pane reading. A confirmed-missing session serves
        // neither, as on the row.
        const structural = this.structuralActivity && session ? this.structuralActivity.getStructuralActivity(session) : null;
        const activity = identityVerdictConfirmsSessionMissing(node.identityVerdict) ? null
          : hookOrPaneActivity(hook, structural)?.activity ?? hook;
        if (seatNeedsAttention(node, activity, arbitratedNeedsInputSignal(arbitrated))) attentionCount++;
      }

      return {
        rigId: r.rig_id,
        name: r.name,
        rigName: r.name,
        nodeCount: r.node_count,
        runningCount: effectiveRunningCount,
        activeCount,
        hasWorkCount,
        status,
        lifecycleState,
        uptime: earliestRunningAt ? formatDuration(now - new Date(earliestRunningAt + "Z").getTime()) : null,
        latestSnapshot: r.latest_snapshot_at ? formatAge(now - new Date(r.latest_snapshot_at + "Z").getTime()) : null,
        archivedAt: r.archived_at,
        isArchived: r.archived_at !== null,
        periodicSnapshotActive: this.periodicSnapshotActive,
        periodicSnapshotIntervalSeconds: this.periodicSnapshotIntervalSeconds,
        autoPeriodicSnapshotCount: r.auto_periodic_count,
        attentionCount,
      };
    });
  }
}

/**
 * Compatibility helper: count pending-only qitems for one canonical session.
 * The wider assigned-work projection uses countAssignedWorkForSession below.
 */
export function countPendingWorkForSession(db: Database.Database, canonicalSessionName: string): number {
  return countAssignedWorkForSession(db, canonicalSessionName).pendingWorkCount;
}

export function countAssignedWorkForSession(
  db: Database.Database,
  canonicalSessionName: string,
): AssignedWorkCounts {
  return readAssignedWorkBySession(db).get(canonicalSessionName) ?? {
    assignedWorkCount: 0,
    pendingWorkCount: 0,
    inProgressWorkCount: 0,
    blockedWorkCount: 0,
  };
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
