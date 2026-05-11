// PL-005 Phase A: Mission Control read layer.
//
// Maps the 7 Mission Control views to data sources:
//   - my-queue            → queue_items where destination_session = operator
//                            AND tier='human-gate'
//   - human-gate          → queue_items where tier='human-gate'
//   - fleet               → shell out to `rig ps --nodes --json` (graceful
//                            degradation per 4-sub-clause spec)
//   - active-work         → queue_items where state in (pending, in-progress,
//                            blocked) sorted by priority
//   - recent-ships        → queue_items where state in (done, handed-off)
//                            ORDER BY ts_updated DESC LIMIT 10
//   - recently-active     → PL-004 Phase B ViewProjector built-in view
//   - recent-observations → stream_items table (Phase A daemon-backed source)
//                            with ~/.openrig/stream/<date>.jsonl as graceful
//                            degradation fallback
//
// Each row carries the 9-field phone-friendly content model (PRD § Acceptance
// Criteria item 1; non-negotiable across all 7 views regardless of UI density).
//
// Source-of-truth integration: PL-004 daemon-backed coordination services
// are the primary read path. Filesystem/CLI fallbacks are for graceful
// degradation only.

import { userInfo } from "node:os";
import type Database from "better-sqlite3";
import type { QueueRepository, QueueItem, QueueState } from "../queue-repository.js";
import type { ViewProjector } from "../view-projector.js";
import type { StreamStore, StreamItem } from "../stream-store.js";
import type { MissionControlFleetCliCapability, FleetRollupRow } from "./mission-control-fleet-cli-capability.js";

export const MISSION_CONTROL_VIEWS = [
  "my-queue",
  "human-gate",
  "fleet",
  "active-work",
  "recent-ships",
  "recently-active",
  "recent-observations",
] as const;

export type MissionControlViewName = (typeof MISSION_CONTROL_VIEWS)[number];

/**
 * The 9-field phone-friendly content model. Per PRD § Acceptance
 * Criteria item 1, non-negotiable across all 7 views wherever
 * row-shaped status is shown. UI may render compact; JSON preserves
 * all 9 fields.
 *
 * 9 fields verbatim from PRD:
 *   1. rig/mission name
 *   2. current phase
 *   3. active/idle/attention/blocked/degraded
 *   4. next-action
 *   5. pending-human-decision
 *   6. read-cost (full / skim/approve / summary-only)
 *   7. last-update timestamp
 *   8. confidence/freshness
 *   9. evidence link
 */
export interface CompactStatusRow {
  rigOrMissionName: string;
  currentPhase: string | null;
  state: "active" | "idle" | "attention" | "blocked" | "degraded";
  nextAction: string | null;
  pendingHumanDecision: string | null;
  readCost: "full" | "skim/approve" | "summary-only" | null;
  lastUpdate: string;
  confidenceFreshness: string | null;
  evidenceLink: string | null;
  /** Carrier metadata (id used for verb actions). */
  qitemId?: string | null;
  rawSourceRef?: string | null;
  /** Human-readable qitem context for phone decisions. */
  qitemSummary?: string | null;
  qitemBody?: string | null;
}

export interface MissionControlReadResult {
  viewName: MissionControlViewName;
  rows: CompactStatusRow[];
  /**
   * Per-view metadata. Includes "rigs running stale CLI" indicator on
   * the fleet view (sub-clause 4 of graceful-degradation acceptance).
   */
  meta: {
    rowCount: number;
    rigsRunningStaleCli?: number;
    degradedFields?: string[];
    sourceFallback?: string;
  };
}

interface ReadLayerDeps {
  db: Database.Database;
  queueRepo: QueueRepository;
  viewProjector: ViewProjector;
  streamStore?: StreamStore;
  fleetCliCapability: MissionControlFleetCliCapability;
  /** Operator's default human-seat session for `my-queue`. */
  defaultOperatorSession?: string;
  now?: () => Date;
}

// V0.3.1 slice 05 kernel-rig-as-default — operator seat resolution
// now cascades through the workspace.operator_seat_name typed setting
// (deps.defaultOperatorSession injected by startup.ts which resolves
// the setting via SettingsStore.resolveConfig()). The ultimate fallback
// derives `operator-${USER}@kernel` from the OS username so a daemon
// booted without the setting still routes my-queue cleanly. The
// previous hardcoded "human-operator@kernel" literal is gone; HG-12.
const RECENT_SHIPS_LIMIT = 10;
const ACTIVE_WORK_LIMIT = 50;
const RECENT_OBSERVATIONS_LIMIT = 50;

const PRIORITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  routine: 2,
  background: 3,
};

export class MissionControlReadLayer {
  private readonly queueRepo: QueueRepository;
  private readonly viewProjector: ViewProjector;
  private readonly streamStore: StreamStore | undefined;
  private readonly fleetCliCapability: MissionControlFleetCliCapability;
  private readonly defaultOperatorSession: string;

  constructor(deps: ReadLayerDeps) {
    this.queueRepo = deps.queueRepo;
    this.viewProjector = deps.viewProjector;
    this.streamStore = deps.streamStore;
    this.fleetCliCapability = deps.fleetCliCapability;
    this.defaultOperatorSession = deps.defaultOperatorSession ?? `operator-${userInfo().username}@kernel`;
  }

  /** V0.3.1 slice 05 — public getter for the resolved operator seat
   *  session. Route handlers (listDestinations, audit history) read
   *  this so the picker + audit filter always offer the configured
   *  operator seat even when the kernel rig isn't booted yet. */
  getDefaultOperatorSession(): string {
    return this.defaultOperatorSession;
  }

  async readView(
    viewName: MissionControlViewName,
    opts?: { operatorSession?: string },
  ): Promise<MissionControlReadResult> {
    switch (viewName) {
      case "my-queue":
        return this.readMyQueue(opts?.operatorSession ?? this.defaultOperatorSession);
      case "human-gate":
        return this.readHumanGate();
      case "fleet":
        return this.readFleet();
      case "active-work":
        return this.readActiveWork();
      case "recent-ships":
        return this.readRecentShips();
      case "recently-active":
        return this.readRecentlyActive();
      case "recent-observations":
        return this.readRecentObservations();
    }
  }

  private readMyQueue(operatorSession: string): MissionControlReadResult {
    const items = this.queueRepo.list({
      destinationSession: operatorSession,
      state: ["pending", "in-progress", "blocked"],
      limit: ACTIVE_WORK_LIMIT,
    });
    const humanGateOnly = items.filter((q) => q.tier === "human-gate");
    return {
      viewName: "my-queue",
      rows: humanGateOnly.map((q) => qitemToRow(q, { defaultReadCost: "skim/approve" })),
      meta: { rowCount: humanGateOnly.length },
    };
  }

  private readHumanGate(): MissionControlReadResult {
    const items = this.queueRepo.list({
      state: ["pending", "in-progress", "blocked"],
      limit: ACTIVE_WORK_LIMIT,
    });
    const humanGateOnly = items.filter((q) => q.tier === "human-gate");
    return {
      viewName: "human-gate",
      rows: humanGateOnly.map((q) => qitemToRow(q, { defaultReadCost: "skim/approve" })),
      meta: { rowCount: humanGateOnly.length },
    };
  }

  private async readFleet(): Promise<MissionControlReadResult> {
    const fleet = await this.fleetCliCapability.rollupFleet();
    const rows: CompactStatusRow[] = fleet.rows.map((r) => fleetRowToCompactRow(r));
    return {
      viewName: "fleet",
      rows,
      meta: {
        rowCount: rows.length,
        rigsRunningStaleCli: fleet.staleCliCount,
        degradedFields: fleet.degradedFields.length > 0 ? fleet.degradedFields : undefined,
        sourceFallback: fleet.sourceFallback ?? undefined,
      },
    };
  }

  private readActiveWork(): MissionControlReadResult {
    const items = this.queueRepo.list({
      state: ["pending", "in-progress", "blocked"],
      limit: ACTIVE_WORK_LIMIT,
    });
    items.sort((a, b) => {
      const ar = PRIORITY_RANK[a.priority] ?? 99;
      const br = PRIORITY_RANK[b.priority] ?? 99;
      if (ar !== br) return ar - br;
      return a.tsUpdated.localeCompare(b.tsUpdated);
    });
    return {
      viewName: "active-work",
      rows: items.map((q) => qitemToRow(q, { defaultReadCost: "full" })),
      meta: { rowCount: items.length },
    };
  }

  private readRecentShips(): MissionControlReadResult {
    const done = this.queueRepo.list({
      state: ["done", "handed-off"],
      limit: RECENT_SHIPS_LIMIT * 4,
    });
    done.sort((a, b) => b.tsUpdated.localeCompare(a.tsUpdated));
    const top = done.slice(0, RECENT_SHIPS_LIMIT);
    return {
      viewName: "recent-ships",
      rows: top.map((q) => qitemToRow(q, { defaultReadCost: "summary-only" })),
      meta: { rowCount: top.length },
    };
  }

  private readRecentlyActive(): MissionControlReadResult {
    // Delegates to PL-004 Phase B's built-in `recently-active` view.
    const result = this.viewProjector.show("recently-active");
    const rows: CompactStatusRow[] = result.rows.map((row) =>
      builtinViewRowToCompactRow("recently-active", row),
    );
    return {
      viewName: "recently-active",
      rows,
      meta: { rowCount: rows.length },
    };
  }

  private readRecentObservations(): MissionControlReadResult {
    if (!this.streamStore) {
      return {
        viewName: "recent-observations",
        rows: [],
        meta: { rowCount: 0, sourceFallback: "stream-store-not-wired" },
      };
    }
    const items: StreamItem[] = this.streamStore.list({ limit: RECENT_OBSERVATIONS_LIMIT });
    const rows = items.map((s) => streamItemToCompactRow(s));
    return {
      viewName: "recent-observations",
      rows,
      meta: { rowCount: rows.length },
    };
  }
}

function qitemToRow(
  q: QueueItem,
  opts: { defaultReadCost: CompactStatusRow["readCost"] },
): CompactStatusRow {
  const state = qitemStateToCompactState(q.state);
  const nextAction = q.state === "blocked" ? `unblock: ${q.blockedOn ?? "external-gate"}` : null;
  const pendingHumanDecision = q.tier === "human-gate" ? `${q.priority} human-gate item` : null;
  return {
    rigOrMissionName: q.destinationSession,
    currentPhase: q.tier ?? null,
    state,
    nextAction,
    pendingHumanDecision,
    readCost: opts.defaultReadCost,
    lastUpdate: q.tsUpdated,
    confidenceFreshness: q.priority,
    evidenceLink: null,
    qitemId: q.qitemId,
    rawSourceRef: q.sourceSession,
    qitemSummary: summarizeBody(q.body),
    qitemBody: q.body,
  };
}

function summarizeBody(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (compact.length <= 120) return compact;
  return `${compact.slice(0, 117).trimEnd()}...`;
}

function qitemStateToCompactState(state: QueueState): CompactStatusRow["state"] {
  switch (state) {
    case "in-progress":
      return "active";
    case "pending":
      return "idle";
    case "blocked":
      return "blocked";
    case "failed":
    case "denied":
    case "canceled":
      return "degraded";
    case "done":
    case "handed-off":
      return "idle";
  }
}

function fleetRowToCompactRow(r: FleetRollupRow): CompactStatusRow {
  return {
    rigOrMissionName: r.rigName,
    currentPhase: r.lifecycleState ?? null,
    state: r.activityState,
    nextAction: r.attentionReason ?? null,
    pendingHumanDecision: null,
    readCost: "summary-only",
    lastUpdate: r.lastUpdate,
    confidenceFreshness: r.cliVersionLabel,
    evidenceLink: null,
    qitemId: null,
    rawSourceRef: r.rigName,
  };
}

function builtinViewRowToCompactRow(
  viewName: string,
  row: Record<string, unknown>,
): CompactStatusRow {
  const get = (k: string): string | null => {
    const v = row[k];
    if (v === undefined || v === null) return null;
    return String(v);
  };
  return {
    rigOrMissionName:
      get("destination_session") ?? get("rig_name") ?? get("rigName") ?? viewName,
    currentPhase: get("tier") ?? get("state") ?? null,
    state: "idle",
    nextAction: null,
    pendingHumanDecision: null,
    readCost: "summary-only",
    lastUpdate: get("ts_updated") ?? get("ts_emitted") ?? new Date().toISOString(),
    confidenceFreshness: get("priority") ?? null,
    evidenceLink: null,
    qitemId: get("qitem_id"),
    rawSourceRef: get("source_session"),
  };
}

function streamItemToCompactRow(s: StreamItem): CompactStatusRow {
  return {
    rigOrMissionName: s.sourceSession,
    currentPhase: s.hintType ?? null,
    state: s.hintUrgency === "critical" ? "attention" : "idle",
    nextAction: s.hintDestination ?? null,
    pendingHumanDecision: null,
    readCost: "summary-only",
    lastUpdate: s.tsEmitted,
    confidenceFreshness: s.hintUrgency ?? null,
    evidenceLink: null,
    qitemId: null,
    rawSourceRef: s.streamItemId,
  };
}
