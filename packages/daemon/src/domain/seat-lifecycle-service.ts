import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter, SessionProbe } from "../adapters/tmux.js";
import type { NodeInventoryEntry, PersistedEvent } from "./types.js";
import { deriveCanonicalFromEntry, getNodeInventory } from "./node-inventory.js";
import { deriveSessionName, parseSessionName } from "./session-name.js";
import type { NodeLauncher } from "./node-launcher.js";
import type { StartupOrchestrator } from "./startup-orchestrator.js";
import type { RuntimeAdapter, ResolvedStartupFile } from "./runtime-adapter.js";
import type { ProjectionEntry, ProjectionPlan } from "./projection-planner.js";
import type { StartupAction } from "./types.js";
import type { OccupantInvalidator } from "./occupant-invalidator.js";
import { rebindAndVerifyPaneIdentity } from "./seat-attention-reconciler.js";
import { observeSolePane } from "./pane-binding-observation.js";
import { createHash } from "node:crypto";

/**
 * S5 (OPR.0.5.4.7) — the seat-lifecycle verb surface: set-model, single-seat stop,
 * dead-session clean. One coherent design (KI-5.3-9):
 *
 *   - ONE seat-resolution path shared by all three verbs (the SeatStatusService
 *     findMatches semantics: parseSessionName greedy first-@ rig; canonical-name or
 *     logical-id match; ambiguity returns the match list) — never a per-verb resolver.
 *   - Every mutation is transactional and persists its audit event in the SAME
 *     transaction (node.model_changed / session.stopped / session.cleaned).
 *   - Every refusal names what was actually checked; an indeterminate tmux probe is
 *     a refusal, never a guess (the S1 error bar applied at birth).
 */

const SEAT_LOOKUP_GUIDANCE = "List seats with: rig ps --nodes";

/** Terminal session statuses — rows the clean verb must NOT touch (they already
 *  record an ended tenancy; the vocabulary is shared with seat-handover-service
 *  and the watchdog's TERMINAL_SESSION_STATUSES). */
const TERMINAL_SESSION_STATUSES = new Set(["superseded", "detached", "exited"]);

export interface SeatLifecycleDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  tmuxAdapter: TmuxAdapter;
  nodeLauncher?: NodeLauncher;
  startupOrchestrator?: StartupOrchestrator;
  runtimeAdapters?: Record<string, RuntimeAdapter>;
  occupantInvalidator?: OccupantInvalidator;
  activityOracle?: { declareOccupantSwap(nodeId: string, generation: string): void };
}

interface ResolvedSeat {
  entry: NodeInventoryEntry;
  nodeId: string;
}

export interface SeatRefusal {
  ok: false;
  code:
    | "seat_ref_required"
    | "seat_not_found"
    | "seat_ambiguous"
    | "missing_model"
    | "missing_reason"
    | "no_session"
    | "claimed_session"
    | "session_not_live"
    | "session_live"
    | "tmux_probe_failed"
    | "nothing_to_clean"
    | "fresh_required"
    | "unmanaged_session_collision"
    | "startup_context_missing"
    | "startup_context_malformed"
    | "startup_context_runtime_mismatch"
    | "runtime_adapter_missing"
    | "launch_unavailable"
    | "launch_failed"
    | "startup_failed"
    | "attention_required"
    | "runtime_identity_unverified";
  message: string;
  guidance?: string;
  matches?: Array<{ rig_name: string; logical_id: string; current_occupant: string | null }>;
}

export interface SeatDescriptor {
  rigId: string;
  rigName: string;
  logicalId: string;
  nodeId: string;
}

export type SetModelResult =
  | { ok: true; seat: SeatDescriptor; from: string | null; to: string; changed: boolean }
  | SeatRefusal;

export type StopSeatResult =
  | { ok: true; seat: SeatDescriptor; sessionName: string; sessionId: string }
  | SeatRefusal;

export type CleanSeatResult =
  | { ok: true; seat: SeatDescriptor; actions: { sessionsExited: string[]; bindingCleared: boolean } }
  | SeatRefusal;

export type LaunchFreshResult =
  | {
      ok: true;
      seat: SeatDescriptor;
      status: "ready";
      sessionName: string;
      sessionId: string;
      generation: string;
      model: string | null;
      startupPolicyHash: string;
      supersededSessionIds: string[];
    }
  | (SeatRefusal & {
      status?: "attention_required" | "failed";
      sessionName?: string;
      sessionId?: string;
      generation?: string;
    });

interface LatestSessionRow {
  id: string;
  session_name: string;
  status: string;
  origin: string;
}

interface PersistedStartupContextRow {
  projection_entries_json: string;
  resolved_files_json: string;
  startup_actions_json: string;
  runtime: string | null;
}

interface ParsedStartupContext {
  plan: ProjectionPlan;
  resolvedStartupFiles: ResolvedStartupFile[];
  startupActions: StartupAction[];
  runtime: string;
  hash: string;
}

export class SeatLifecycleService {
  private readonly db: Database.Database;
  private readonly rigRepo: RigRepository;
  private readonly sessionRegistry: SessionRegistry;
  private readonly eventBus: EventBus;
  private readonly tmuxAdapter: TmuxAdapter;
  private readonly nodeLauncher: NodeLauncher | null;
  private readonly startupOrchestrator: StartupOrchestrator | null;
  private readonly runtimeAdapters: Record<string, RuntimeAdapter>;
  private readonly occupantInvalidator: OccupantInvalidator | null;
  private readonly activityOracle: SeatLifecycleDeps["activityOracle"] | null;

  constructor(deps: SeatLifecycleDeps) {
    if (deps.db !== deps.rigRepo.db) throw new Error("SeatLifecycleService: rigRepo must share the same db handle");
    if (deps.db !== deps.sessionRegistry.db) throw new Error("SeatLifecycleService: sessionRegistry must share the same db handle");
    if (deps.db !== deps.eventBus.db) throw new Error("SeatLifecycleService: eventBus must share the same db handle");
    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.nodeLauncher = deps.nodeLauncher ?? null;
    this.startupOrchestrator = deps.startupOrchestrator ?? null;
    this.runtimeAdapters = deps.runtimeAdapters ?? {};
    this.occupantInvalidator = deps.occupantInvalidator ?? null;
    this.activityOracle = deps.activityOracle ?? null;
  }

  async setModel(input: { seatRef: string; model: string; reason: string; operator?: string | null }): Promise<SetModelResult> {
    const required = this.requireReason(input.reason);
    if (required) return required;
    if (!input.model?.trim()) {
      return { ok: false, code: "missing_model", message: "A target model id is required (--model)." };
    }
    const resolved = this.resolveSeat(input.seatRef);
    if ("code" in resolved) return resolved;

    const model = input.model.trim();
    const seat = this.describe(resolved);
    const from = resolved.entry.model ?? null;
    if (from === model) {
      // Honest no-op: the persisted value already IS the target; no event is minted.
      return { ok: true, seat, from, to: model, changed: false };
    }

    let persisted: PersistedEvent | null = null;
    const tx = this.db.transaction(() => {
      this.rigRepo.setNodeModel(resolved.nodeId, model);
      persisted = this.eventBus.persistWithinTransaction({
        type: "node.model_changed",
        rigId: seat.rigId,
        nodeId: seat.nodeId,
        logicalId: seat.logicalId,
        from,
        to: model,
        reason: input.reason.trim(),
        operator: input.operator ?? null,
      });
    });
    tx();
    if (persisted) this.eventBus.notifySubscribers(persisted);

    return { ok: true, seat, from, to: model, changed: true };
  }

  async stopSeat(input: { seatRef: string; reason: string; operator?: string | null }): Promise<StopSeatResult> {
    const required = this.requireReason(input.reason);
    if (required) return required;
    const resolved = this.resolveSeat(input.seatRef);
    if ("code" in resolved) return resolved;
    const seat = this.describe(resolved);

    const session = this.latestSession(resolved.nodeId);
    if (!session) {
      return { ok: false, code: "no_session", message: `Seat "${input.seatRef}" has no session to stop (checked: latest sessions row for node ${seat.logicalId}).` };
    }
    if (session.origin === "claimed") {
      return {
        ok: false,
        code: "claimed_session",
        message: `Session "${session.session_name}" was adopted (origin=claimed), not launched by OpenRig — stop refuses to kill it.`,
        guidance: "Release an adopted session with: rig unclaim",
      };
    }

    // Wave-2 fix round 1 (r1 row 9baac99f): consume the CLASSIFIED probe, never the
    // collapsed hasSession view — a transport blip is INDETERMINATE, not absence
    // (KI-5.3-8 fabricated-absence class, destructive direction).
    const probed = await this.probeLiveness(session.session_name, "stop refuses rather than kill blind");
    if ("code" in probed) return probed;
    if (probed.state === "absent") {
      return {
        ok: false,
        code: "session_not_live",
        message: `Session "${session.session_name}" is absent in tmux (checked: tmux has-session, POSITIVE absence evidence) — there is nothing to stop.`,
        guidance: "A dead seat with stale records is returned to launchable with: rig seat clean",
      };
    }

    return this.stopManagedTmuxSeat(resolved, session, input.reason, input.operator);
  }

  async cleanSeat(input: { seatRef: string; reason: string; operator?: string | null }): Promise<CleanSeatResult> {
    const required = this.requireReason(input.reason);
    if (required) return required;
    const resolved = this.resolveSeat(input.seatRef);
    if ("code" in resolved) return resolved;
    const seat = this.describe(resolved);

    const binding = this.sessionRegistry.getBindingForNode(resolved.nodeId);
    const nonTerminal = (this.db.prepare(
      "SELECT id, session_name, status, origin FROM sessions WHERE node_id = ? ORDER BY id",
    ).all(resolved.nodeId) as LatestSessionRow[])
      .filter((s) => !TERMINAL_SESSION_STATUSES.has(s.status));

    // Fix r2-F3 (row 30045f39): clean MUTATES every non-terminal session row, so
    // its safety checks must cover exactly that set — probing only the newest row
    // fabricates safety for the others (older-live/newer-dead under canonical-name
    // churn). Every row that would be touched is checked for adopted origin and
    // probed for POSITIVE absence (r1 discipline); the binding's own tmux session
    // is probed too when it names a session no row carries.
    const mutationTargets = nonTerminal;
    for (const row of mutationTargets) {
      if (row.origin === "claimed") {
        return {
          ok: false,
          code: "claimed_session",
          message: `Session "${row.session_name}" was adopted (origin=claimed) — clean refuses to touch adopted state.`,
          guidance: "Release an adopted session with: rig unclaim",
        };
      }
    }
    const probeNames = [...new Set([
      ...mutationTargets.map((s) => s.session_name),
      ...(binding?.tmuxSession ? [binding.tmuxSession] : []),
    ])];
    for (const name of probeNames) {
      const probed = await this.probeLiveness(name, "clean refuses rather than clear state under a possibly-live seat");
      if ("code" in probed) return probed;
      if (probed.state === "present") {
        return {
          ok: false,
          code: "session_live",
          message: `Session "${name}" is alive in tmux (checked: tmux has-session, against EVERY session row clean would mutate) — clean only operates on dead seats.`,
          guidance: "Stop a live seat first with: rig seat stop",
        };
      }
    }
    const session = this.latestSession(resolved.nodeId);

    if (!binding && nonTerminal.length === 0) {
      return {
        ok: false,
        code: "nothing_to_clean",
        message: `Seat "${input.seatRef}" is already clean (checked: no binding row for the node, and no session rows outside terminal statuses ${[...TERMINAL_SESSION_STATUSES].join("/")}).`,
      };
    }

    const sessionsExited: string[] = [];
    let persisted: PersistedEvent | null = null;
    const tx = this.db.transaction(() => {
      for (const row of nonTerminal) {
        this.sessionRegistry.updateStatus(row.id, "exited");
        sessionsExited.push(row.session_name);
      }
      this.sessionRegistry.clearBinding(resolved.nodeId);
      persisted = this.eventBus.persistWithinTransaction({
        type: "session.cleaned",
        rigId: seat.rigId,
        nodeId: seat.nodeId,
        sessionName: session?.session_name ?? null,
        reason: input.reason.trim(),
        operator: input.operator ?? null,
        actions: { sessionsExited, bindingCleared: binding !== null },
      });
    });
    tx();
    if (persisted) this.eventBus.notifySubscribers(persisted);

    return { ok: true, seat, actions: { sessionsExited, bindingCleared: binding !== null } };
  }

  /** Deliberately replace exactly one managed seat with a blank native occupant. */
  async launchFresh(input: {
    seatRef: string;
    fresh: boolean;
    reason: string;
    stop?: boolean;
    operator?: string | null;
  }): Promise<LaunchFreshResult> {
    const required = this.requireReason(input.reason);
    if (required) return required;
    if (input.fresh !== true) {
      return {
        ok: false,
        code: "fresh_required",
        message: "Explicit fresh launch requires fresh=true (--fresh); no continuity mode is inferred.",
      };
    }
    const resolved = this.resolveSeat(input.seatRef);
    if ("code" in resolved) return resolved;
    const seat = this.describe(resolved);
    const rig = this.rigRepo.getRig(seat.rigId);
    const node = rig?.nodes.find((candidate) => candidate.id === seat.nodeId);
    if (!rig || !node) {
      return { ok: false, code: "seat_not_found", message: `Seat "${input.seatRef}" no longer exists.`, guidance: SEAT_LOOKUP_GUIDANCE };
    }
    if (!this.nodeLauncher || !this.startupOrchestrator) {
      return { ok: false, code: "launch_unavailable", message: "Fresh-launch services are unavailable in this daemon." };
    }

    const startup = this.readStartupContext(node.id, node.cwd ?? ".");
    if (!startup.ok) return startup.refusal;
    if (!node.runtime || startup.context.runtime !== node.runtime) {
      return {
        ok: false,
        code: "startup_context_runtime_mismatch",
        message: `Persisted startup context runtime '${startup.context.runtime}' does not match current node runtime '${node.runtime ?? "missing"}'.`,
      };
    }
    const adapter = this.runtimeAdapters[node.runtime];
    if (!adapter) {
      return {
        ok: false,
        code: "runtime_adapter_missing",
        message: `No runtime adapter is available for '${node.runtime}'.`,
      };
    }

    const canonicalSessionName = deriveCanonicalFromEntry(resolved.entry)
      ?? deriveSessionName(seat.rigName, seat.logicalId);
    const retiringRows = this.nonTerminalSessions(node.id);
    if (retiringRows.some((row) => row.origin === "claimed")) {
      return {
        ok: false,
        code: "claimed_session",
        message: `Seat "${input.seatRef}" has an adopted/operator-owned occupant; fresh launch refuses even with --stop.`,
        guidance: "Stop the adopted process yourself, then run rig seat clean before launching fresh.",
      };
    }
    const supersededSessionIds = retiringRows.map((row) => row.id);
    const retiringGeneration = this.sessionRegistry.currentOccupantTenure(node.id)?.generationUuid ?? null;

    const canonicalProbe = await this.probeLiveness(
      canonicalSessionName,
      "fresh launch refuses rather than overwrite a possibly-live canonical session",
    );
    if ("code" in canonicalProbe) return canonicalProbe;
    if (canonicalProbe.state === "present") {
      const currentSession = this.latestSession(node.id);
      const currentBinding = this.sessionRegistry.getBindingForNode(node.id);
      const currentManaged = currentSession !== null
        && !TERMINAL_SESSION_STATUSES.has(currentSession.status)
        && currentSession.origin !== "claimed"
        && currentSession.session_name === canonicalSessionName
        && currentBinding?.tmuxSession === canonicalSessionName;
      if (!currentManaged) {
        return {
          ok: false,
          code: "unmanaged_session_collision",
          message: `Canonical tmux session "${canonicalSessionName}" exists but is not owned by this seat's current managed rows; refusing to overwrite it.`,
        };
      }
      if (!input.stop) {
        return {
          ok: false,
          code: "session_live",
          message: `Seat "${input.seatRef}" is live; fresh launch refuses without --stop.`,
          guidance: "Re-run with --stop to end exactly this managed occupant, or use rig handover to carry context.",
        };
      }
      const observedPane = await observeSolePane(this.tmuxAdapter, canonicalSessionName);
      if (!observedPane.ok && observedPane.code === "tmux_unavailable") {
        return {
          ok: false,
          code: "tmux_probe_failed",
          message: `${observedPane.detail}; fresh launch refuses rather than kill without live occupant identity.`,
        };
      }
      if (!observedPane.ok || observedPane.pane !== currentBinding?.tmuxPane) {
        return {
          ok: false,
          code: "unmanaged_session_collision",
          message: `Canonical tmux session "${canonicalSessionName}" is live, but its pane does not match this seat's current managed binding; refusing to stop it.`,
        };
      }
      const stopped = await this.stopManagedTmuxSeat(
        resolved,
        currentSession,
        input.reason,
        input.operator,
      );
      if (!stopped.ok) return stopped;
    }

    // Reuse clean's exhaustive, positive-absence gate for stale/history rows.
    const remaining = this.nonTerminalSessions(node.id);
    const binding = this.sessionRegistry.getBindingForNode(node.id);
    if (remaining.length > 0 || binding !== null) {
      const cleaned = await this.cleanSeat({
        seatRef: canonicalSessionName,
        reason: input.reason,
        operator: input.operator,
      });
      if (!cleaned.ok) return cleaned;
    }

    // The stop/clean composition may have taken time; buy absence again at the
    // mutation boundary. NodeLauncher also refuses duplicate_session and never kills it.
    const finalProbe = await this.probeLiveness(
      canonicalSessionName,
      "fresh launch refuses rather than race a canonical-session collision",
    );
    if ("code" in finalProbe) return finalProbe;
    if (finalProbe.state === "present") {
      return {
        ok: false,
        code: "unmanaged_session_collision",
        message: `Canonical tmux session "${canonicalSessionName}" appeared before launch; refusing to overwrite it.`,
      };
    }

    // Historical rows remain append-only but no longer look current.
    for (const sessionId of supersededSessionIds) this.sessionRegistry.markSuperseded(sessionId);
    this.occupantInvalidator?.invalidateRetiringOccupant({
      retiringSessionName: canonicalSessionName,
      successorSessionName: canonicalSessionName,
      ...(retiringGeneration ? { retiringGeneration } : {}),
    });

    const launch = await this.nodeLauncher.launchNode(seat.rigId, seat.logicalId, {
      sessionName: canonicalSessionName,
      cwd: node.cwd ?? undefined,
      occupantKind: "fresh",
    });
    if (!launch.ok) {
      return { ok: false, code: "launch_failed", message: launch.message };
    }
    const observedGeneration = this.sessionRegistry.currentOccupantTenure(node.id)?.generationUuid ?? null;
    const generation = observedGeneration && observedGeneration !== retiringGeneration
      ? observedGeneration
      : null;
    if (!generation) {
      const compensation = await this.compensateFailedFreshLaunch({
        seat,
        launch,
        supersededSessionIds,
        retiringGeneration,
        newGeneration: null,
        startupPolicyHash: startup.context.hash,
        model: node.model,
        reason: input.reason,
        operator: input.operator,
        errors: ["new occupant generation was not persisted"],
      });
      return compensation === "zero"
        ? { ok: false, code: "startup_failed", status: "failed", message: "Fresh launch could not persist a new occupant generation; the new session was rolled back." }
        : { ok: false, code: "attention_required", status: "attention_required", message: "Fresh launch could not persist a new occupant generation and the new process could not be confirmed stopped; the seat requires attention.", sessionName: canonicalSessionName, sessionId: launch.session.id };
    }
    this.activityOracle?.declareOccupantSwap(node.id, generation);

    const launchPosture = this.rigRepo.getNodePolicyProvenance(node.id)?.launchPosture
      ?? this.rigRepo.getRigPolicyProvenance(seat.rigId)?.launchPosture
      ?? "floor";
    const startupResult = await this.startupOrchestrator.startNode({
      rigId: seat.rigId,
      nodeId: node.id,
      sessionId: launch.session.id,
      binding: {
        ...launch.binding,
        cwd: node.cwd ?? ".",
        model: node.model ?? undefined,
        codexConfigProfile: node.codexConfigProfile ?? undefined,
        launchPosture,
      },
      adapter,
      plan: startup.context.plan,
      resolvedStartupFiles: startup.context.resolvedStartupFiles,
      startupActions: startup.context.startupActions,
      isRestore: false,
      sessionName: canonicalSessionName,
      allowFreshFallback: false,
    });

    if (!startupResult.ok && startupResult.startupStatus === "failed") {
      const compensation = await this.compensateFailedFreshLaunch({
        seat,
        launch,
        supersededSessionIds,
        retiringGeneration,
        newGeneration: generation,
        startupPolicyHash: startup.context.hash,
        model: node.model,
        reason: input.reason,
        operator: input.operator,
        errors: startupResult.errors,
      });
      return compensation === "zero"
        ? {
            ok: false,
            code: "startup_failed",
            status: "failed",
            message: `Fresh startup failed and was rolled back to zero live session/binding: ${startupResult.errors.join("; ")}`,
          }
        : {
            ok: false,
            code: "attention_required",
            status: "attention_required",
            message: `Fresh startup failed and the new process could not be confirmed stopped; the seat requires attention: ${startupResult.errors.join("; ")}`,
            sessionName: canonicalSessionName,
            sessionId: launch.session.id,
            generation,
          };
    }

    const identity = await rebindAndVerifyPaneIdentity({
      db: this.db,
      sessionRegistry: this.sessionRegistry,
      tmux: this.tmuxAdapter,
      nodeId: node.id,
      sessionName: canonicalSessionName,
      runtime: node.runtime,
      expectedResumeToken: this.sessionResumeToken(launch.session.id),
    });
    const attentionRequired = !startupResult.ok || !identity.ok;
    if (!identity.ok) this.sessionRegistry.updateStartupStatus(launch.session.id, "attention_required");

    let persisted: PersistedEvent | null = null;
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE nodes SET
          occupant_lifecycle = 'active',
          continuity_outcome = 'fresh',
          handover_result = NULL,
          previous_occupant = ?,
          handover_at = ?
        WHERE id = ?
      `).run(retiringRows.at(-1)?.session_name ?? null, new Date().toISOString(), node.id);
      const nativeSessionId = this.sessionResumeToken(launch.session.id);
      persisted = this.eventBus.persistWithinTransaction({
        type: "seat.fresh_launched",
        rigId: seat.rigId,
        nodeId: node.id,
        logicalId: seat.logicalId,
        sessionName: canonicalSessionName,
        sessionId: launch.session.id,
        supersededSessionIds,
        retiringGeneration,
        newGeneration: generation,
        nativeSessionId,
        ...(nativeSessionId ? {} : { nativeSessionIdReason: "scrape_miss" }),
        model: node.model,
        startupPolicyHash: startup.context.hash,
        reason: input.reason.trim(),
        operator: input.operator ?? null,
        status: attentionRequired ? "attention_required" : "ready",
      });
    });
    tx();
    if (persisted) this.eventBus.notifySubscribers(persisted);

    if (attentionRequired) {
      return {
        ok: false,
        code: startupResult.ok ? "runtime_identity_unverified" : "attention_required",
        status: "attention_required",
        message: startupResult.ok
          ? `Fresh occupant started but runtime identity requires attention: ${identity.ok ? "unknown" : identity.detail}`
          : `Fresh occupant started but startup requires attention: ${startupResult.errors.join("; ")}`,
        sessionName: canonicalSessionName,
        sessionId: launch.session.id,
        generation,
      };
    }

    return {
      ok: true,
      seat,
      status: "ready",
      sessionName: canonicalSessionName,
      sessionId: launch.session.id,
      generation,
      model: node.model,
      startupPolicyHash: startup.context.hash,
      supersededSessionIds,
    };
  }

  // -- shared internals --

  private async stopManagedTmuxSeat(
    resolved: ResolvedSeat,
    session: LatestSessionRow,
    reason: string,
    operator?: string | null,
  ): Promise<StopSeatResult> {
    const seat = this.describe(resolved);
    const kill = await this.tmuxAdapter.killSession(session.session_name);
    if (kill && !kill.ok && kill.code !== "session_not_found") {
      return {
        ok: false,
        code: "tmux_probe_failed",
        message: `tmux kill-session for "${session.session_name}" failed: ${kill.message ?? kill.code}`,
      };
    }
    let persisted: PersistedEvent | null = null;
    const tx = this.db.transaction(() => {
      this.sessionRegistry.updateStatus(session.id, "exited");
      this.sessionRegistry.clearBinding(resolved.nodeId);
      persisted = this.eventBus.persistWithinTransaction({
        type: "session.stopped",
        rigId: seat.rigId,
        nodeId: seat.nodeId,
        sessionName: session.session_name,
        reason: reason.trim(),
        operator: operator ?? null,
      });
    });
    tx();
    if (persisted) this.eventBus.notifySubscribers(persisted);
    return { ok: true, seat, sessionName: session.session_name, sessionId: session.id };
  }

  private nonTerminalSessions(nodeId: string): LatestSessionRow[] {
    return (this.db.prepare(
      "SELECT id, session_name, status, origin FROM sessions WHERE node_id = ? ORDER BY created_at, id",
    ).all(nodeId) as LatestSessionRow[]).filter((row) => !TERMINAL_SESSION_STATUSES.has(row.status));
  }

  private sessionResumeToken(sessionId: string): string | null {
    const row = this.db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(sessionId) as
      | { resume_token: string | null }
      | undefined;
    return row?.resume_token?.trim() || null;
  }

  private readStartupContext(
    nodeId: string,
    cwd: string,
  ): { ok: true; context: ParsedStartupContext } | { ok: false; refusal: SeatRefusal } {
    const row = this.db.prepare(
      "SELECT projection_entries_json, resolved_files_json, startup_actions_json, runtime FROM node_startup_context WHERE node_id = ?",
    ).get(nodeId) as PersistedStartupContextRow | undefined;
    if (!row) {
      return {
        ok: false,
        refusal: {
          ok: false,
          code: "startup_context_missing",
          message: `Persisted startup context is missing for node ${nodeId}; fresh launch refuses to invent an empty startup policy.`,
        },
      };
    }

    let rawEntries: unknown;
    let rawFiles: unknown;
    let rawActions: unknown;
    try {
      rawEntries = JSON.parse(row.projection_entries_json);
      rawFiles = JSON.parse(row.resolved_files_json);
      rawActions = JSON.parse(row.startup_actions_json);
    } catch (error) {
      return this.malformedStartupContext(nodeId, `JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Array.isArray(rawEntries) || !Array.isArray(rawFiles) || !Array.isArray(rawActions) || !row.runtime?.trim()) {
      return this.malformedStartupContext(nodeId, "projection entries, resolved files, and startup actions must be arrays and runtime must be non-empty");
    }

    const entries: ProjectionEntry[] = [];
    for (const raw of rawEntries) {
      if (!isRecord(raw)
        || !isProjectionCategory(raw["category"])
        || !hasStrings(raw, ["effectiveId", "sourceSpec", "sourcePath", "resourcePath", "absolutePath"])
        || !isOptionalString(raw["resourceType"])
        || !isOptionalString(raw["target"])
        || !isOptionalOneOf(raw["mergeStrategy"], ["managed_block", "append"] as const)
        || !isOptionalOneOf(raw["pluginType"], ["claude", "codex", "auto"] as const)) {
        return this.malformedStartupContext(nodeId, "projection_entries_json contains an invalid entry");
      }
      // S04 owns the live ambient skill set. Replaying the older catalog
      // selection here could reinstall a skill that work-install removed.
      if (raw["category"] === "skill") continue;
      entries.push({
        category: raw["category"],
        effectiveId: raw["effectiveId"],
        sourceSpec: raw["sourceSpec"],
        sourcePath: raw["sourcePath"],
        resourcePath: raw["resourcePath"],
        absolutePath: raw["absolutePath"],
        classification: "safe_projection",
        ...(typeof raw["resourceType"] === "string" ? { resourceType: raw["resourceType"] } : {}),
        ...(typeof raw["mergeStrategy"] === "string" ? { mergeStrategy: raw["mergeStrategy"] as ProjectionEntry["mergeStrategy"] } : {}),
        ...(typeof raw["target"] === "string" ? { target: raw["target"] } : {}),
        ...(typeof raw["pluginType"] === "string" ? { pluginType: raw["pluginType"] as ProjectionEntry["pluginType"] } : {}),
      });
    }

    const resolvedStartupFiles: ResolvedStartupFile[] = [];
    for (const raw of rawFiles) {
      if (!isRecord(raw)
        || !hasStrings(raw, ["path", "absolutePath", "ownerRoot"])
        || !isOneOf(raw["deliveryHint"], ["auto", "guidance_merge", "skill_install", "send_text"] as const)
        || typeof raw["required"] !== "boolean"
        || !isStringArrayOf(raw["appliesOn"], ["fresh_start", "restore"] as const)
        || !isOptionalOneOf(raw["kind"], ["file"] as const)) {
        return this.malformedStartupContext(nodeId, "resolved_files_json contains an invalid entry");
      }
      resolvedStartupFiles.push({
        path: raw["path"],
        absolutePath: raw["absolutePath"],
        ownerRoot: raw["ownerRoot"],
        deliveryHint: raw["deliveryHint"],
        required: raw["required"],
        appliesOn: raw["appliesOn"],
        ...(raw["kind"] === "file" ? { kind: "file" as const } : {}),
      });
    }

    const startupActions: StartupAction[] = [];
    for (const raw of rawActions) {
      if (!isRecord(raw)
        || !isOneOf(raw["type"], ["slash_command", "send_text"] as const)
        || typeof raw["value"] !== "string"
        || !isOneOf(raw["phase"], ["after_files", "after_ready"] as const)
        || !isStringArrayOf(raw["appliesOn"], ["fresh_start", "restore"] as const)
        || typeof raw["idempotent"] !== "boolean"
        || !isOptionalOneOf(raw["builtin"], ["session_identity"] as const)) {
        return this.malformedStartupContext(nodeId, "startup_actions_json contains an invalid entry");
      }
      startupActions.push({
        type: raw["type"],
        value: raw["value"],
        phase: raw["phase"],
        appliesOn: raw["appliesOn"],
        idempotent: raw["idempotent"],
        ...(raw["builtin"] === "session_identity" ? { builtin: "session_identity" as const } : {}),
      });
    }

    const startupFiles = resolvedStartupFiles.map((file) => ({
      kind: file.kind,
      path: file.path,
      deliveryHint: file.deliveryHint,
      required: file.required,
      appliesOn: file.appliesOn,
    }));
    const plan: ProjectionPlan = {
      runtime: row.runtime,
      cwd,
      entries,
      startup: { files: startupFiles, actions: startupActions },
      conflicts: [],
      noOps: [],
      diagnostics: [],
    };
    const hash = createHash("sha256")
      .update(JSON.stringify([row.projection_entries_json, row.resolved_files_json, row.startup_actions_json, row.runtime]))
      .digest("hex");
    return { ok: true, context: { plan, resolvedStartupFiles, startupActions, runtime: row.runtime, hash } };
  }

  private malformedStartupContext(
    nodeId: string,
    detail: string,
  ): { ok: false; refusal: SeatRefusal } {
    return {
      ok: false,
      refusal: {
        ok: false,
        code: "startup_context_malformed",
        message: `Persisted startup context is malformed for node ${nodeId}: ${detail}.`,
      },
    };
  }

  private async compensateFailedFreshLaunch(input: {
    seat: SeatDescriptor;
    launch: Extract<Awaited<ReturnType<NodeLauncher["launchNode"]>>, { ok: true }>;
    supersededSessionIds: string[];
    retiringGeneration: string | null;
    newGeneration: string | null;
    startupPolicyHash: string;
    model: string | null;
    reason: string;
    operator?: string | null;
    errors: string[];
  }): Promise<"zero" | "attention"> {
    const kill = await this.tmuxAdapter.killSession(input.launch.sessionName);
    const stopped = !kill || kill.ok || kill.code === "session_not_found";
    const errors = stopped
      ? input.errors
      : [...input.errors, `tmux kill-session failed: ${kill.message ?? kill.code}`];
    let persisted: PersistedEvent | null = null;
    const tx = this.db.transaction(() => {
      if (stopped) {
        this.sessionRegistry.updateStatus(input.launch.session.id, "exited");
        this.sessionRegistry.clearBinding(input.seat.nodeId);
        this.db.prepare(
          "UPDATE nodes SET occupant_lifecycle = 'unknown', continuity_outcome = 'failed' WHERE id = ?",
        ).run(input.seat.nodeId);
      } else {
        this.sessionRegistry.updateStartupStatus(input.launch.session.id, "attention_required");
        this.db.prepare(
          "UPDATE nodes SET occupant_lifecycle = 'active', continuity_outcome = 'fresh' WHERE id = ?",
        ).run(input.seat.nodeId);
      }
      persisted = this.eventBus.persistWithinTransaction({
        type: "seat.fresh_launch_failed",
        rigId: input.seat.rigId,
        nodeId: input.seat.nodeId,
        logicalId: input.seat.logicalId,
        sessionName: input.launch.sessionName,
        sessionId: input.launch.session.id,
        supersededSessionIds: input.supersededSessionIds,
        retiringGeneration: input.retiringGeneration,
        newGeneration: input.newGeneration,
        model: input.model,
        startupPolicyHash: input.startupPolicyHash,
        reason: input.reason.trim(),
        operator: input.operator ?? null,
        errors,
      });
    });
    tx();
    if (persisted) this.eventBus.notifySubscribers(persisted);
    return stopped ? "zero" : "attention";
  }

  /**
   * The ONE liveness read both mutating verbs share (fix r1, row 9baac99f):
   * the CLASSIFIED probeSession, never the collapsed hasSession view.
   *   present / absent        → returned for the verb to act on (absent is
   *                             POSITIVE tmux evidence, per OPR.0.5.4.2).
   *   transport_unavailable   → an INDETERMINATE refusal: session existence was
   *                             NOT determined, so neither verb may act — and the
   *                             refusal never routes the operator to a
   *                             destructive verb.
   *   unexpected probe throw  → the same indeterminate refusal (fail closed).
   */
  private async probeLiveness(
    sessionName: string,
    refusalConsequence: string,
  ): Promise<{ state: "present" | "absent" } | SeatRefusal> {
    let probe: SessionProbe;
    try {
      probe = await this.tmuxAdapter.probeSession(sessionName);
    } catch (err) {
      return {
        ok: false,
        code: "tmux_probe_failed",
        message: `tmux liveness probe for "${sessionName}" failed (${err instanceof Error ? err.message : String(err)}) — liveness is INDETERMINATE, so ${refusalConsequence}.`,
      };
    }
    if (probe.state === "transport_unavailable") {
      return {
        ok: false,
        code: "tmux_probe_failed",
        message: `tmux transport unavailable probing "${sessionName}" (${probe.cause}) — session existence was NOT determined (checked: classified tmux probe), so ${refusalConsequence}. Retry when the tmux transport is back.`,
      };
    }
    return { state: probe.state };
  }

  private requireReason(reason: string): SeatRefusal | null {
    if (!reason?.trim()) {
      return { ok: false, code: "missing_reason", message: "An audit reason is required (--reason)." };
    }
    return null;
  }

  private describe(resolved: ResolvedSeat): SeatDescriptor {
    return {
      rigId: resolved.entry.rigId,
      rigName: resolved.entry.rigName,
      logicalId: resolved.entry.logicalId,
      nodeId: resolved.nodeId,
    };
  }

  private latestSession(nodeId: string): LatestSessionRow | null {
    const row = this.db.prepare(
      "SELECT id, session_name, status, origin FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1",
    ).get(nodeId) as LatestSessionRow | undefined;
    return row ?? null;
  }

  /** The ONE resolution path, mirroring SeatStatusService.findMatches semantics
   *  (seat-status-service.ts) so every seat verb resolves identically: a canonical
   *  `name@rig` ref scopes to that rig's inventory; a bare ref scans all rigs;
   *  matches are by canonicalSessionName or logicalId; >1 match is a listed
   *  ambiguity, never a pick. */
  private resolveSeat(seatRef: string): ResolvedSeat | SeatRefusal {
    const ref = seatRef?.trim() ?? "";
    if (!ref) {
      return { ok: false, code: "seat_ref_required", message: "seat reference is required", guidance: SEAT_LOOKUP_GUIDANCE };
    }

    const matches = this.findMatches(ref);
    if (matches.length === 0) {
      return {
        ok: false,
        code: "seat_not_found",
        message: `Seat "${ref}" not found (checked: canonical session names and logical ids across ${parseSessionName(ref).kind === "canonical" ? "the named rig" : "all rigs"}).`,
        guidance: SEAT_LOOKUP_GUIDANCE,
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        code: "seat_ambiguous",
        message: `Seat "${ref}" matched multiple nodes`,
        guidance: SEAT_LOOKUP_GUIDANCE,
        matches: matches.map((entry) => ({
          rig_name: entry.rigName,
          logical_id: entry.logicalId,
          current_occupant: entry.canonicalSessionName,
        })),
      };
    }

    const entry = matches[0]!;
    const nodeRow = this.db.prepare(
      "SELECT id FROM nodes WHERE rig_id = ? AND logical_id = ?",
    ).get(entry.rigId, entry.logicalId) as { id: string } | undefined;
    if (!nodeRow) {
      return { ok: false, code: "seat_not_found", message: `Seat "${ref}" resolved to a node that no longer exists.`, guidance: SEAT_LOOKUP_GUIDANCE };
    }
    return { entry, nodeId: nodeRow.id };
  }

  private findMatches(ref: string): NodeInventoryEntry[] {
    const parsed = parseSessionName(ref);
    if (parsed.kind === "canonical") {
      const localRef = parsed.member;
      const rigs = this.rigRepo.findRigsByName(parsed.rig);
      return rigs.flatMap((rig) => getNodeInventory(this.db, rig.id).filter((entry) =>
        entry.canonicalSessionName === ref
        || deriveCanonicalFromEntry(entry) === ref
        || entry.logicalId === localRef,
      ));
    }
    return this.rigRepo.listRigs().flatMap((rig) =>
      getNodeInventory(this.db, rig.id).filter((entry) =>
        entry.canonicalSessionName === ref || entry.logicalId === ref,
      ),
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStrings<T extends string>(value: Record<string, unknown>, keys: readonly T[]): value is Record<T, string> & Record<string, unknown> {
  return keys.every((key) => typeof value[key] === "string" && value[key].trim().length > 0);
}

function isProjectionCategory(value: unknown): value is ProjectionEntry["category"] {
  return isOneOf(value, ["skill", "guidance", "subagent", "plugin", "runtime_resource"] as const);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isOptionalOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T | undefined {
  return value === undefined || isOneOf(value, allowed);
}

function isStringArrayOf<T extends string>(value: unknown, allowed: readonly T[]): value is T[] {
  return Array.isArray(value) && value.every((entry) => isOneOf(entry, allowed));
}
