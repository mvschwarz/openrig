import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { DiscoveryRepository } from "./discovery-repository.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { SeatStatusService, type SeatStatus, type SeatStatusResult } from "./seat-status-service.js";
import { SeatHandoverPlanner, parseHandoverSource, type SeatHandoverPlan, type SeatHandoverSource } from "./seat-handover-planner.js";
import type { PersistedEvent } from "./types.js";

export interface SeatHandoverMutationResult {
  ok: true;
  dryRun: false;
  mutated: true;
  continuityTransferred: false;
  seat: SeatHandoverPlan["seat"];
  source: SeatHandoverSource & { mode: "discovered"; ref: string };
  reason: string;
  operator: string | null;
  previousOccupant: string;
  currentOccupant: string;
  previousSessionIdsSuperseded: string[];
  newSessionId: string;
  discovery: {
    id: string;
    status: "claimed";
    tmuxSession: string;
    tmuxPane: string | null;
  };
  currentStatus: SeatHandoverPlan["currentStatus"];
  handoverAt: string;
  eventSeq: number;
  sideEffects: {
    departingSessionKilled: false;
    startupContextDelivered: false;
    provenanceRecordWritten: false;
  };
}

export type SeatHandoverResult =
  | { ok: true; plan: SeatHandoverPlan }
  | { ok: true; result: SeatHandoverMutationResult }
  | { ok: false; code: "missing_reason" | "invalid_source" | "successor_creation_not_implemented"; message: string; guidance: string }
  | { ok: false; code: "current_occupant_required" | "discovered_not_active" | "successor_tmux_absent" | "successor_already_managed" | "successor_is_current" | "runtime_mismatch"; message: string; guidance: string }
  | { ok: false; code: "discovered_not_found"; message: string; guidance: string }
  | { ok: false; code: "tmux_probe_failed" | "handover_commit_failed"; message: string; guidance: string }
  | Extract<SeatStatusResult, { ok: false }>;

interface NodeRow {
  id: string;
  runtime: string | null;
}

interface SessionRow {
  id: string;
  session_name: string;
  status: string;
}

interface BindingOwnerRow {
  node_id: string;
  logical_id: string;
  rig_name: string;
}

interface SeatHandoverServiceDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  discoveryRepo: DiscoveryRepository;
  eventBus: EventBus;
  tmuxAdapter: TmuxAdapter;
  now?: () => Date;
}

export class SeatHandoverService {
  private db: Database.Database;
  private statusService: SeatStatusService;
  private planner: SeatHandoverPlanner;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private discoveryRepo: DiscoveryRepository;
  private eventBus: EventBus;
  private tmuxAdapter: TmuxAdapter;
  private now: () => Date;

  constructor(deps: SeatHandoverServiceDeps) {
    if (deps.db !== deps.rigRepo.db) throw new Error("SeatHandoverService: rigRepo must share the same db handle");
    if (deps.db !== deps.sessionRegistry.db) throw new Error("SeatHandoverService: sessionRegistry must share the same db handle");
    if (deps.db !== deps.discoveryRepo.db) throw new Error("SeatHandoverService: discoveryRepo must share the same db handle");
    if (deps.db !== deps.eventBus.db) throw new Error("SeatHandoverService: eventBus must share the same db handle");
    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.discoveryRepo = deps.discoveryRepo;
    this.eventBus = deps.eventBus;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.now = deps.now ?? (() => new Date());
    this.statusService = new SeatStatusService({ rigRepo: deps.rigRepo });
    this.planner = new SeatHandoverPlanner({ rigRepo: deps.rigRepo });
  }

  async handover(input: {
    seatRef: string;
    reason?: string | null;
    source?: string | null;
    operator?: string | null;
    dryRun?: boolean;
  }): Promise<SeatHandoverResult> {
    if (input.dryRun) {
      const planResult = this.planner.plan({ ...input, dryRun: true });
      if (planResult.ok) {
        return { ok: true, plan: planResult.plan };
      }
      switch (planResult.code) {
        case "mutation_disabled":
          return {
            ok: false,
            code: "successor_creation_not_implemented",
            message: "Seat handover mutation is not available through dry-run planning.",
            guidance: "Re-run with --dry-run to inspect the two-phase handover plan without changing topology.",
          };
        case "missing_reason":
        case "invalid_source":
          return {
            ok: false,
            code: planResult.code,
            message: planResult.message,
            guidance: planResult.guidance,
          };
        case "seat_ref_required":
        case "seat_not_found":
        case "seat_ambiguous":
          return planResult;
      }
    }

    const reason = input.reason?.trim() ?? "";
    if (!reason) {
      return {
        ok: false,
        code: "missing_reason",
        message: "Missing required option: --reason <reason>",
        guidance: "Provide an explicit handover reason, for example: --reason context-wall",
      };
    }

    const parsed = parseHandoverSource(input.source);
    if (!parsed.ok) {
      return parsed;
    }
    if (parsed.source.mode !== "discovered" || !parsed.source.ref) {
      return {
        ok: false,
        code: "successor_creation_not_implemented",
        message: `Seat handover mutation for source "${parsed.source.raw}" is not implemented in this slice.`,
        guidance: "For live mutation in this slice, provide an already-created successor with --source discovered:<id>.",
      };
    }

    const statusResult = this.statusService.getStatus(input.seatRef);
    if (!statusResult.ok) {
      return statusResult;
    }
    if (!statusResult.status.current_occupant) {
      return {
        ok: false,
        code: "current_occupant_required",
        message: `Seat "${input.seatRef}" has no current occupant to hand over from.`,
        guidance: "Start or claim the current seat occupant first, then retry handover.",
      };
    }

    const node = this.lookupNode(statusResult.status);
    const latestSession = this.lookupLatestSession(node.id);
    if (!latestSession) {
      return {
        ok: false,
        code: "current_occupant_required",
        message: `Seat "${input.seatRef}" has no session row to supersede.`,
        guidance: "Inspect the seat with: rig seat status <seat>",
      };
    }

    const discovered = this.discoveryRepo.getDiscoveredSession(parsed.source.ref);
    if (!discovered) {
      return {
        ok: false,
        code: "discovered_not_found",
        message: `Discovery record "${parsed.source.ref}" not found.`,
        guidance: "Run discovery and list active discovered sessions before retrying.",
      };
    }
    if (discovered.status !== "active") {
      return {
        ok: false,
        code: "discovered_not_active",
        message: `Discovery record "${discovered.id}" is ${discovered.status}, not active.`,
        guidance: "Use an active, unclaimed discovered successor session.",
      };
    }
    if (discovered.tmuxSession === latestSession.session_name) {
      return {
        ok: false,
        code: "successor_is_current",
        message: "Discovered successor is already the current occupant for this seat.",
        guidance: "Use a distinct successor session.",
      };
    }

    const runtimeMismatch = this.checkRuntimeMismatch(node.runtime, discovered.runtimeHint);
    if (runtimeMismatch) return runtimeMismatch;

    const managedOwner = this.lookupManagedOwner(discovered.tmuxSession, node.id);
    if (managedOwner) {
      return {
        ok: false,
        code: "successor_already_managed",
        message: `Successor tmux session "${discovered.tmuxSession}" is already managed by ${managedOwner.logical_id}@${managedOwner.rig_name}.`,
        guidance: "Use an unclaimed discovered successor session.",
      };
    }

    let tmuxPresent: boolean;
    try {
      tmuxPresent = await this.tmuxAdapter.hasSession(discovered.tmuxSession);
    } catch (err) {
      return {
        ok: false,
        code: "tmux_probe_failed",
        message: `Could not verify successor tmux session "${discovered.tmuxSession}": ${err instanceof Error ? err.message : String(err)}`,
        guidance: "Retry after tmux health is known; probe failures are not treated as absence.",
      };
    }
    if (!tmuxPresent) {
      return {
        ok: false,
        code: "successor_tmux_absent",
        message: `Successor tmux session "${discovered.tmuxSession}" is not present.`,
        guidance: "Run discovery again or provide a live discovered successor session.",
      };
    }

    return this.commit({
      seatRef: input.seatRef,
      status: statusResult.status,
      node,
      latestSession,
      source: parsed.source as SeatHandoverSource & { mode: "discovered"; ref: string },
      reason,
      operator: input.operator?.trim() || null,
      discovered,
    });
  }

  private checkRuntimeMismatch(nodeRuntime: string | null, discoveredRuntime: string): SeatHandoverResult | null {
    if (!nodeRuntime || discoveredRuntime === "unknown" || nodeRuntime === discoveredRuntime) {
      return null;
    }
    return {
      ok: false,
      code: "runtime_mismatch",
      message: `Seat expects runtime "${nodeRuntime}", but discovered successor is "${discoveredRuntime}".`,
      guidance: "Use a discovered successor with a matching runtime hint.",
    };
  }

  private lookupNode(status: SeatStatus): NodeRow {
    return this.db.prepare(
      "SELECT id, runtime FROM nodes WHERE rig_id = ? AND logical_id = ?"
    ).get(status.rig_id, status.logical_id) as NodeRow;
  }

  private lookupLatestSession(nodeId: string): SessionRow | null {
    return this.db.prepare(
      "SELECT id, session_name, status FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1"
    ).get(nodeId) as SessionRow | undefined ?? null;
  }

  private lookupManagedOwner(tmuxSession: string, targetNodeId: string): BindingOwnerRow | null {
    const bindingOwner = this.db.prepare(`
      SELECT n.id AS node_id, n.logical_id, r.name AS rig_name
      FROM bindings b
      JOIN nodes n ON n.id = b.node_id
      JOIN rigs r ON r.id = n.rig_id
      WHERE b.tmux_session = ? AND n.id != ?
      LIMIT 1
    `).get(tmuxSession, targetNodeId) as BindingOwnerRow | undefined;
    if (bindingOwner) return bindingOwner;

    return this.db.prepare(`
      SELECT n.id AS node_id, n.logical_id, r.name AS rig_name
      FROM sessions s
      JOIN nodes n ON n.id = s.node_id
      JOIN rigs r ON r.id = n.rig_id
      WHERE s.session_name = ? AND n.id != ? AND s.status NOT IN ('superseded', 'detached', 'exited')
      LIMIT 1
    `).get(tmuxSession, targetNodeId) as BindingOwnerRow | undefined ?? null;
  }

  private commit(input: {
    seatRef: string;
    status: SeatStatus;
    node: NodeRow;
    latestSession: SessionRow;
    source: SeatHandoverSource & { mode: "discovered"; ref: string };
    reason: string;
    operator: string | null;
    discovered: ReturnType<DiscoveryRepository["getDiscoveredSession"]> & NonNullable<unknown>;
  }): SeatHandoverResult {
    const handoverAt = this.now().toISOString();
    const tx = this.db.transaction(() => {
      const rows = this.db.prepare(
        "SELECT id FROM sessions WHERE node_id = ? AND status NOT IN ('superseded', 'detached', 'exited') ORDER BY id"
      ).all(input.node.id) as Array<{ id: string }>;
      const previousSessionIdsSuperseded = rows.map((row) => row.id);

      if (previousSessionIdsSuperseded.length > 0) {
        const placeholders = previousSessionIdsSuperseded.map(() => "?").join(",");
        this.db.prepare(
          `UPDATE sessions SET status = 'superseded', last_seen_at = datetime('now') WHERE id IN (${placeholders})`
        ).run(...previousSessionIdsSuperseded);
      }

      this.upsertBinding(input.node.id, {
        tmuxSession: input.discovered.tmuxSession,
        tmuxWindow: input.discovered.tmuxWindow,
        tmuxPane: input.discovered.tmuxPane,
      });
      const newSession = this.sessionRegistry.registerClaimedSession(input.node.id, input.discovered.tmuxSession);
      this.discoveryRepo.markClaimed(input.discovered.id, input.node.id);
      this.db.prepare(`
        UPDATE nodes SET
          occupant_lifecycle = 'active',
          continuity_outcome = NULL,
          handover_result = 'complete',
          previous_occupant = ?,
          handover_at = ?
        WHERE id = ?
      `).run(input.latestSession.session_name, handoverAt, input.node.id);
      const event = this.eventBus.persistWithinTransaction({
        type: "seat.handover_completed",
        rigId: input.status.rig_id,
        nodeId: input.node.id,
        logicalId: input.status.logical_id,
        previousOccupant: input.latestSession.session_name,
        currentOccupant: input.discovered.tmuxSession,
        source: input.source.raw,
        reason: input.reason,
        operator: input.operator,
      });
      return { newSessionId: newSession.id, previousSessionIdsSuperseded, event };
    });

    let committed: { newSessionId: string; previousSessionIdsSuperseded: string[]; event: PersistedEvent };
    try {
      committed = tx();
    } catch (err) {
      return {
        ok: false,
        code: "handover_commit_failed",
        message: `Seat handover commit failed: ${err instanceof Error ? err.message : String(err)}`,
        guidance: "Inspect daemon logs and retry after the seat state is consistent.",
      };
    }

    this.eventBus.notifySubscribers(committed.event);
    const postStatus = this.statusService.getStatus(`${input.status.logical_id}@${input.status.rig_name}`);
    const currentStatus = postStatus.ok
      ? {
          sessionStatus: postStatus.status.session_status,
          startupStatus: postStatus.status.startup_status,
          occupantLifecycle: postStatus.status.occupant_lifecycle,
          continuityOutcome: postStatus.status.continuity_outcome,
          handoverResult: postStatus.status.handover_result,
          previousOccupant: postStatus.status.previous_occupant,
          handoverAt: postStatus.status.handover_at,
          restoreOutcome: postStatus.status.restore_outcome,
        }
      : {
          sessionStatus: "running",
          startupStatus: "ready" as const,
          occupantLifecycle: "active" as const,
          continuityOutcome: null,
          handoverResult: "complete" as const,
          previousOccupant: input.latestSession.session_name,
          handoverAt,
          restoreOutcome: input.status.restore_outcome,
        };

    return {
      ok: true,
      result: {
        ok: true,
        dryRun: false,
        mutated: true,
        continuityTransferred: false,
        seat: {
          ref: input.seatRef,
          rigId: input.status.rig_id,
          rigName: input.status.rig_name,
          logicalId: input.status.logical_id,
          podId: input.status.pod_id,
          podNamespace: input.status.pod_namespace,
          runtime: input.status.runtime,
        },
        source: input.source,
        reason: input.reason,
        operator: input.operator,
        previousOccupant: input.latestSession.session_name,
        currentOccupant: input.discovered.tmuxSession,
        previousSessionIdsSuperseded: committed.previousSessionIdsSuperseded,
        newSessionId: committed.newSessionId,
        discovery: {
          id: input.discovered.id,
          status: "claimed",
          tmuxSession: input.discovered.tmuxSession,
          tmuxPane: input.discovered.tmuxPane,
        },
        currentStatus,
        handoverAt,
        eventSeq: committed.event.seq,
        sideEffects: {
          departingSessionKilled: false,
          startupContextDelivered: false,
          provenanceRecordWritten: false,
        },
      },
    };
  }

  private upsertBinding(nodeId: string, fields: { tmuxSession: string; tmuxWindow: string | null; tmuxPane: string | null }): void {
    const existing = this.db.prepare("SELECT id FROM bindings WHERE node_id = ?").get(nodeId) as { id: string } | undefined;
    if (existing) {
      this.db.prepare(`
        UPDATE bindings SET
          attachment_type = 'tmux',
          tmux_session = ?,
          tmux_window = ?,
          tmux_pane = ?,
          external_session_name = NULL,
          updated_at = datetime('now')
        WHERE node_id = ?
      `).run(fields.tmuxSession, fields.tmuxWindow, fields.tmuxPane, nodeId);
      return;
    }

    this.db.prepare(`
      INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_window, tmux_pane)
      VALUES (?, ?, 'tmux', ?, ?, ?)
    `).run(ulid(), nodeId, fields.tmuxSession, fields.tmuxWindow, fields.tmuxPane);
  }
}
