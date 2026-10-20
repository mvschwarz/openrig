import type { NativeProcessLister } from "./native-process-lineage.js";
import type { CurrentModelReader } from "./model-divergence/current-model-reader.js";
import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter, SessionProbe } from "../adapters/tmux.js";
import { shellQuote } from "../adapters/shell-quote.js";
import { EFFORT_SHAPE, piThinkingValue } from "../adapters/pi-runner-protocol.js";
import type { NodeInventoryEntry, PersistedEvent } from "./types.js";
import { deriveCanonicalFromEntry, getNodeInventory } from "./node-inventory.js";
import { deriveSessionName, parseSessionName } from "./session-name.js";
import type { NodeLauncher } from "./node-launcher.js";
import type { PendingStartupContext, StartupOrchestrator } from "./startup-orchestrator.js";
import type { RuntimeAdapter, ResolvedStartupFile } from "./runtime-adapter.js";
import type { ProjectionEntry, ProjectionPlan } from "./projection-planner.js";
import type { StartupAction } from "./types.js";
import { resolveStartupProof } from "./startup-resolver.js";
import { reanchorBuiltinStartupFile, reanchorShippedProjectionEntry } from "./builtin-startup-files.js";
import type { OccupantInvalidator } from "./occupant-invalidator.js";
import { rebindAndVerifyPaneIdentity } from "./seat-attention-reconciler.js";
import { observeSolePane } from "./pane-binding-observation.js";
import { createHash } from "node:crypto";
import { NativePermissionStore } from "./native-permission-store.js";
import { validateNativePermissionSelection, unresolvedClaudePermissionModes } from "./native-permission-selection.js";
import fs from "node:fs";
import path from "node:path";
import { resolveConcreteHint, type NodeBinding } from "./runtime-adapter.js";
import { ProjectionManifestStore } from "./projection-manifest-store.js";
import { planCwdPreparation } from "./seat-cwd-preparation.js";
import { resolvePermissionPolicyAttachment, validatePermissionPolicyRef } from "./permission-policy/policy-ref.js";
import type { ArbitratedSeatState } from "./activity-taxonomy.js";
import type { PaneCutoverTiming } from "./pane-cutover.js";
import {
  effortPrecedence, emittedEffortFromArgv, readNativeEffort, resolveSeatEffort, unknownLevelWarning,
  type EffortResolution, type NativeEffortObservation,
} from "./seat-effort.js";
import {
  claudeCommandSessionToken, codexCommandResumeToken, observeClaudePaneRuntime, observeCodexPaneProcess, processArgv,
} from "./native-process-lineage.js";
import { defaultInPlaceRestartIo } from "./seat-restart-in-place.js";
import nodePath from "node:path";
import {
  CodexInPlaceRestart, type InPlaceCodexLauncher, type InPlaceRestartIo, type InPlaceRestartRefusal,
  type InPlaceRestartReport, type InPlaceRestartTarget, type InPlaceVerifyResult,
} from "./seat-restart-in-place.js";
import { CommunityHarnessRuntimeAdapter, seatAdapter } from "../adapters/community-harness-runtime-adapter.js";
import { sessionCommunityHarnessSelect } from "./session-registry.js";

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
  listProcesses?: NativeProcessLister;
  nodeLauncher?: NodeLauncher;
  startupOrchestrator?: StartupOrchestrator;
  runtimeAdapters?: Record<string, RuntimeAdapter>;
  occupantInvalidator?: OccupantInvalidator;
  activityOracle?: { declareOccupantSwap(nodeId: string, generation: string): void; getSeatState?(nodeId: string): ArbitratedSeatState | null };
  /** Test seams for the in-place restart's OS reads and stop timing; production uses the defaults. */
  inPlaceRestartIo?: Partial<InPlaceRestartIo>;
  inPlaceRestartTiming?: Partial<PaneCutoverTiming>;
  inPlaceRestartDaemonStartedAt?: Date;
  /** Where a session's native transcript is (the context-usage store); without it native effort is NOT VERIFIED. */
  transcripts?: { readSidecar(sessionName: string): { ok: true; data: { transcript_path?: string | null; session_id?: string | null } } | { ok: false }; readCodexTranscriptPath(threadId: string): string | null };
  /** The identity-verified current Pi runner and its own session file; without it a Pi seat's launch and native effort are unknown. */
  piRecords?: Pick<CurrentModelReader, "currentPiRecord">;
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
    | "missing_cwd"
    | "invalid_cwd"
    | "cwd_check_failed"
    | "cwd_persistence_failed"
    | "cwd_configuration_changed"
    | "cwd_destination_conflict"
    | "missing_reason"
    | "permission_selection_refused"
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
    | "runtime_identity_unverified"
    | "not_codex"
    | "typing_guard_enabled"
    | "missing_effort"
    | "invalid_effort"
    | "effort_unsupported_runtime"
    | "effort_unavailable"
    | "invalid_policy";
  message: string;
  guidance?: string;
  matches?: Array<{ rig_name: string; logical_id: string; current_occupant: string | null }>;
}

export type RestartInPlaceResult = InPlaceRestartReport | InPlaceRestartRefusal | SeatRefusal;
export type VerifyRestartInPlaceResult = InPlaceVerifyResult | SeatRefusal;

export interface SeatDescriptor {
  rigId: string;
  rigName: string;
  logicalId: string;
  nodeId: string;
}

export type SetModelResult =
  | { ok: true; seat: SeatDescriptor; from: string | null; to: string; changed: boolean }
  | SeatRefusal;

export type SetCwdResult =
  | { ok: true; seat: SeatDescriptor; from: string | null; to: string; changed: boolean;
      effect: "next_launch"; warnings: string[] }
  | (SeatRefusal & { warnings?: string[] });

interface SetCwdInput {
  seatRef: string;
  cwd: string;
  reason: string;
  operator?: string | null;
}

export type SetPolicyResult =
  | { ok: true; seat: SeatDescriptor; from: string | null; to: string; launchPosture: "floor" | "full_bypass" | "auto"; changed: boolean; effect: string }
  | SeatRefusal;

/** OPR.0.7.0.7 — the four effort values for one seat, kept apart. */
export interface EffortReport {
  ok: true;
  seat: SeatDescriptor;
  runtime: string;
  /** The last rig seat set-effort for this seat (null: never set, or cleared and never set since). */
  requested: { value: string | null; at: string; reason: string; operator: string | null } | null;
  /** What the seat's next managed continuation sends. */
  saved: EffortResolution;
  /** The effort flag on the running process's own command line: what its launch sent. */
  emitted:
    | { state: "observed"; value: string | null; pid: number; startedAt: string | null; matchesSaved: boolean }
    | { state: "unknown"; detail: string };
  /** What the native session recorded for a turn since that process started. */
  observed: NativeEffortObservation & { matchesEmitted?: boolean };
  precedence: { decided: boolean; detail: string };
  summary: string;
}

export type SetEffortResult =
  | {
      ok: true;
      seat: SeatDescriptor;
      runtime: string;
      /** What was asked for: a level, or null for --clear. */
      requested: string | null;
      from: EffortResolution;
      /** What is saved now, and what the next managed continuation resolves to from it. */
      saved: EffortResolution;
      changed: boolean;
      /** Whether the seat's session is live in tmux now; unknown when the probe couldn't tell. */
      running: "yes" | "no" | "unknown";
      runningDetail?: string;
      /** Emitted at launch and observed natively are separate facts this command can't know. */
      emitted: "not_yet";
      observed: "not_observed";
      /** Set when the level isn't one the runtime is known to accept; the choice is saved anyway. */
      warning?: string;
      effect: string;
    }
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
      effort?: string | null;
      startupPolicyHash: string;
      supersededSessionIds: string[];
      warnings?: string[];
    }
  | (SeatRefusal & {
      status?: "attention_required" | "failed";
      sessionName?: string;
      sessionId?: string;
      generation?: string;
      warnings?: string[];
    });

interface LatestSessionRow {
  id: string;
  session_name: string;
  status: string;
  origin: string;
  community_harness?: string | null;
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
  private readonly listProcesses?: NativeProcessLister;
  private readonly nodeLauncher: NodeLauncher | null;
  private readonly startupOrchestrator: StartupOrchestrator | null;
  private readonly runtimeAdapters: Record<string, RuntimeAdapter>;
  private readonly occupantInvalidator: OccupantInvalidator | null;
  private readonly activityOracle: SeatLifecycleDeps["activityOracle"] | null;
  private readonly inPlaceRestartIo?: Partial<InPlaceRestartIo>;
  private readonly inPlaceRestartTiming?: Partial<PaneCutoverTiming>;
  private readonly inPlaceRestartDaemonStartedAt?: Date;
  private readonly transcripts: SeatLifecycleDeps["transcripts"] | null;
  private readonly piRecords: SeatLifecycleDeps["piRecords"] | null;

  constructor(deps: SeatLifecycleDeps) {
    if (deps.db !== deps.rigRepo.db) throw new Error("SeatLifecycleService: rigRepo must share the same db handle");
    if (deps.db !== deps.sessionRegistry.db) throw new Error("SeatLifecycleService: sessionRegistry must share the same db handle");
    if (deps.db !== deps.eventBus.db) throw new Error("SeatLifecycleService: eventBus must share the same db handle");
    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.listProcesses = deps.listProcesses;
    this.nodeLauncher = deps.nodeLauncher ?? null;
    this.startupOrchestrator = deps.startupOrchestrator ?? null;
    this.runtimeAdapters = deps.runtimeAdapters ?? {};
    this.occupantInvalidator = deps.occupantInvalidator ?? null;
    this.activityOracle = deps.activityOracle ?? null;
    this.inPlaceRestartIo = deps.inPlaceRestartIo;
    this.inPlaceRestartTiming = deps.inPlaceRestartTiming;
    this.inPlaceRestartDaemonStartedAt = deps.inPlaceRestartDaemonStartedAt;
    this.transcripts = deps.transcripts ?? null;
    this.piRecords = deps.piRecords ?? null;
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

  /**
   * Save an existing seat's launch directory for its next fresh launch or rebuild handover, keeping its identity,
   * address, queue and history. Like set-model it validates, then persists the cwd and an audited event in one
   * transaction. Before that, set-cwd's read-only preflight policy refuses the change when the new directory holds an
   * operator-edited, unrecorded-and-different or doubly sourced copy that launch would place there. It creates the
   * folder and writes no startup files: launch does that, as it does today. The running occupant keeps its directory
   * until it's relaunched.
   */
  async setCwd(input: SetCwdInput): Promise<SetCwdResult> {
    const required = this.requireReason(input.reason);
    if (required) return required;
    if (!input.cwd?.trim()) return { ok: false, code: "missing_cwd", message: "An absolute working directory is required (--cwd)." };
    if (!path.isAbsolute(input.cwd) || input.cwd.includes("\0")) {
      return { ok: false, code: "invalid_cwd", message: "The working directory must be an absolute path on the daemon's host." };
    }
    let to = path.resolve(input.cwd);
    if (to === path.parse(to).root) {
      return { ok: false, code: "invalid_cwd", message: "Choose a project directory, not a filesystem root, for managed startup files." };
    }
    const resolved = this.resolveSeat(input.seatRef);
    if ("code" in resolved) return resolved;
    const seat = this.describe(resolved);
    const node = this.rigRepo.getRig(seat.rigId)?.nodes.find(candidate => candidate.id === seat.nodeId);
    if (!node) return { ok: false, code: "seat_not_found", message: "The seat no longer exists.", guidance: SEAT_LOOKUP_GUIDANCE };
    const from = node.cwd;
    try {
      fs.mkdirSync(to, { recursive: true });
      to = fs.realpathSync(to);
      if (to === path.parse(to).root || !fs.statSync(to).isDirectory()) throw new Error("Destination must be a project directory.");
    } catch (error) {
      return { ok: false, code: "invalid_cwd", message: `Cannot use the requested working directory: ${(error as Error).message}` };
    }
    const startup = this.readStartupContext(node.id, to);
    if (!startup.ok) return startup.refusal;
    if (!node.runtime || startup.context.runtime !== node.runtime) {
      return { ok: false, code: "startup_context_runtime_mismatch", message: "The saved startup context belongs to a different runtime." };
    }
    // Resolved as launch resolves it, so a recorded community harness finds its adapter too.
    const adapter = seatAdapter(this.runtimeAdapters, node.runtime, this.latestSession(node.id)?.community_harness);
    if (!adapter) return { ok: false, code: "runtime_adapter_missing", message: "The configured runtime adapter is unavailable." };

    const warnings: string[] = [];
    // The filesystem startup files the next fresh launch would deliver (never send_text or actions), with legacy auto
    // hints resolved, for the read-only destination check.
    const files: ResolvedStartupFile[] = [];
    // A community harness takes no startup files at launch (its adapter delivers none), so there's nothing to check.
    const takesStartupFiles = !(adapter instanceof CommunityHarnessRuntimeAdapter);
    for (const file of takesStartupFiles ? startup.context.resolvedStartupFiles : []) {
      if (!file.appliesOn.includes("fresh_start") || file.deliveryHint === "send_text") continue;
      try {
        const hint = file.deliveryHint === "auto"
          ? resolveConcreteHint(file.path, fs.readFileSync(file.absolutePath, "utf8")) : file.deliveryHint;
        if (hint !== "send_text") files.push({ ...file, deliveryHint: hint });
      } catch (error) {
        const detail = `Startup file ${file.path}: ${(error as Error).message}`;
        if (file.required) return { ok: false, code: "cwd_check_failed", message: detail, warnings };
        warnings.push(detail);
      }
    }
    const oldBinding = this.sessionRegistry.getBindingForNode(node.id);
    const binding: NodeBinding = {
      id: oldBinding?.id ?? `cwd:${node.id}`, nodeId: node.id,
      attachmentType: oldBinding?.attachmentType ?? "tmux",
      tmuxSession: oldBinding?.tmuxSession ?? deriveCanonicalFromEntry(resolved.entry),
      tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null,
      updatedAt: oldBinding?.updatedAt ?? new Date().toISOString(), cwd: to,
    };
    const inspect = `Inspect the configured directory with: rig seat status ${input.seatRef}`;
    try {
      const check = planCwdPreparation({ ...startup.context.plan, cwd: to }, files, binding, adapter, new ProjectionManifestStore(this.db));
      warnings.push(...check.warnings);
      if (check.conflicts.length) {
        warnings.push(...check.conflicts.map(copy => `Protected destination file: ${copy.targetPath}`));
        return { ok: false, code: "cwd_destination_conflict", warnings,
          message: "The new directory holds files set-cwd's preflight policy protects; no startup file was written and the cwd was not changed.",
          guidance: "Use a clean destination, or inspect and move or merge the reported files before retrying." };
      }
    } catch (error) {
      return { ok: false, code: "cwd_check_failed", message: `The new directory couldn't be checked; the cwd was not changed: ${(error as Error).message}`, warnings };
    }

    let persisted: PersistedEvent | null = null;
    const changed = from !== to;
    try {
      const refusal = this.db.transaction((): SeatRefusal | null => {
        // Another writer (an import, another connection) must not be silently overwritten.
        const current = this.resolveSeat(input.seatRef);
        const currentStartup = this.readStartupContext(node.id, to);
        if ("code" in current || current.nodeId !== node.id || current.entry.cwd !== from
          || current.entry.runtime !== node.runtime || !currentStartup.ok || currentStartup.context.hash !== startup.context.hash) {
          return { ok: false, code: "cwd_configuration_changed", message: "The seat's configuration changed while its new directory was checked; the cwd was not changed.", guidance: inspect };
        }
        if (changed) {
          if (!this.rigRepo.setNodeCwd(node.id, to, from)) throw new Error("The seat's saved working directory changed.");
          persisted = this.eventBus.persistWithinTransaction({ type: "node.cwd_changed", rigId: seat.rigId,
            nodeId: node.id, logicalId: seat.logicalId, from, to, reason: input.reason.trim(), operator: input.operator ?? null });
        }
        return null;
      })();
      if (refusal) return { ...refusal, warnings };
    } catch (error) {
      return { ok: false, code: "cwd_persistence_failed", message: `The working directory was not changed: ${(error as Error).message}`, guidance: inspect, warnings };
    }
    if (persisted) this.eventBus.notifySubscribers(persisted);
    return { ok: true, seat, from, to, changed, effect: "next_launch", warnings };
  }

  /** OPR.0.7.0.7 — save one seat's effort for its next managed continuation. Like set-model it
   *  validates, writes, and persists an audited event in the same transaction; it never restarts
   *  the seat or touches its peers, model or account. `effort: null` clears the explicit choice. */
  async setEffort(input: { seatRef: string; effort: string | null; reason: string; operator?: string | null }): Promise<SetEffortResult> {
    const required = this.requireReason(input.reason);
    if (required) return required;
    const requested = input.effort === null ? null : input.effort.trim();
    if (requested !== null) {
      if (!requested) return { ok: false, code: "missing_effort", message: "An effort level is required (--effort <level>), or pass --clear." };
      // Levels are the runtime's own (they differ by model and client), so only the shape is checked here.
      if (!EFFORT_SHAPE.test(requested)) {
        return { ok: false, code: "invalid_effort", message: `"${requested}" isn't an effort level: use the runtime's level name, such as low, medium or high.` };
      }
    }
    const resolved = this.resolveSeat(input.seatRef);
    if ("code" in resolved) return resolved;
    const seat = this.describe(resolved);
    const runtime = resolved.entry.runtime ?? "unknown";
    if (runtime !== "claude-code" && runtime !== "codex" && runtime !== "pi") {
      return { ok: false, code: "effort_unsupported_runtime", message: `Seat "${input.seatRef}" runs ${runtime}; reasoning effort applies to claude-code, codex and pi seats only.` };
    }

    const from = this.readEffort(seat.nodeId);
    if (!from) {
      return { ok: false, code: "effort_unavailable", message: "This daemon's database has no per-seat effort choice (checked: nodes.effort_choice column); nothing was saved." };
    }
    let changed = false;
    if (from.choice !== requested) {
      let persisted: PersistedEvent | null = null;
      this.db.transaction(() => {
        if (!this.rigRepo.setNodeEffortChoice(seat.nodeId, requested)) return;
        changed = true;
        persisted = this.eventBus.persistWithinTransaction({
          type: "node.effort_changed",
          rigId: seat.rigId,
          nodeId: seat.nodeId,
          logicalId: seat.logicalId,
          from: from.choice,
          to: requested,
          reason: input.reason.trim(),
          operator: input.operator ?? null,
        });
      })();
      if (persisted) this.eventBus.notifySubscribers(persisted);
      if (!changed) {
        return { ok: false, code: "effort_unavailable", message: `The effort choice for seat "${input.seatRef}" was not saved (no node row was updated); nothing changed.` };
      }
    }
    const saved = this.readEffort(seat.nodeId) ?? from;
    const running = await this.runningState(seat.nodeId);
    const effect = requested === null
      ? `Cleared: the seat has no saved effort choice now, so it goes back to ${saved.source === "authored" ? `the spec's authored effort ${saved.authored}` : "no effort flag (the runtime's own default)"} at its next managed launch, resume, restore or spec refresh. An in-place restart keeps the running effort and refuses if it would change it. The running process is unchanged; nothing was restarted.`
      : `Saved for the seat's next managed continuation. The running process is unchanged; nothing was restarted.`;
    return {
      ok: true, seat, runtime, requested, from, saved, changed,
      running: running.state, ...(running.detail ? { runningDetail: running.detail } : {}),
      emitted: "not_yet", observed: "not_observed", effect,
      ...(unknownLevelWarning(runtime, requested) ? { warning: unknownLevelWarning(runtime, requested) } : {}),
    };
  }

  /** OPR.0.7.0.7 — requested, saved, emitted at launch and observed in the native session, each from
   *  its own source. Reads only. An unseen value is reported as unknown or NOT VERIFIED, never guessed. */
  async effortReport(seatRef: string): Promise<EffortReport | SeatRefusal> {
    const resolved = this.resolveSeat(seatRef);
    if ("code" in resolved) return resolved;
    const seat = this.describe(resolved);
    const runtime = resolved.entry.runtime ?? "unknown";
    if (runtime !== "claude-code" && runtime !== "codex" && runtime !== "pi") {
      return { ok: false, code: "effort_unsupported_runtime", message: `Seat "${seatRef}" runs ${runtime}; reasoning effort applies to claude-code, codex and pi seats only.` };
    }
    const saved = this.readEffort(seat.nodeId);
    if (!saved) {
      return { ok: false, code: "effort_unavailable", message: "This daemon's database has no per-seat effort choice (checked: nodes.effort_choice column)." };
    }
    const requested = this.lastRequestedEffort(seat.nodeId);
    const precedence = { decided: effortPrecedence.decided, detail: effortPrecedence.detail };

    let emitted: EffortReport["emitted"];
    let observed: EffortReport["observed"];
    const session = this.latestSession(seat.nodeId);
    const binding = this.sessionRegistry.getBindingForNode(seat.nodeId);
    const target = binding?.tmuxPane ?? binding?.tmuxSession ?? null;
    if (!session || TERMINAL_SESSION_STATUSES.has(session.status) || !target) {
      emitted = { state: "unknown", detail: "The seat has no running session, so no launch to read." };
      observed = { state: "not_verified", detail: "The seat has no running session." };
    } else if (runtime === "pi") {
      ({ emitted, observed } = await this.piEffort(seat.nodeId, session.session_name, saved));
    } else {
      const observe = runtime === "claude-code" ? observeClaudePaneRuntime : observeCodexPaneProcess;
      const process = (await observe({ target, tmux: this.tmuxAdapter, ...(this.listProcesses ? { listProcesses: this.listProcesses } : {}) }))?.process;
      if (!process) {
        emitted = { state: "unknown", detail: `No single ${runtime === "claude-code" ? "Claude" : "Codex"} process could be read in the seat's pane.` };
        observed = { state: "not_verified", detail: "The running process could not be read, so no turn can be tied to its launch." };
      } else {
        const flag = emittedEffortFromArgv(runtime, processArgv(process.command));
        const value = flag.flag === "present" ? flag.value : null;
        emitted = { state: "observed", value, pid: process.pid, startedAt: process.startedAt ?? null, matchesSaved: value === saved.effective };
        // Native effort is attributed only from the transcript of the conversation this process is on.
        const joined = await this.joinedTranscript(runtime, session, process);
        const native = "detail" in joined ? { state: "not_verified" as const, detail: joined.detail }
          : readNativeEffort(runtime, joined.path, process.startedAt ?? null);
        observed = native.state === "observed" ? { ...native, matchesEmitted: native.value === value } : native;
      }
    }
    return { ok: true, seat, runtime, requested, saved, emitted, observed, precedence, summary: effortSummary(saved, emitted, observed, runtime) };
  }

  /** A Pi seat's launch flag and native level, both from the identity-verified current runner: its
   *  own command line, and the newest assistant record of this launch in its own session file. */
  private async piEffort(nodeId: string, sessionName: string, saved: EffortResolution): Promise<Pick<EffortReport, "emitted" | "observed">> {
    if (!this.piRecords) {
      return {
        emitted: { state: "unknown", detail: "The seat's Pi runner can't be read here." },
        observed: { state: "not_verified", detail: "The seat's Pi runner can't be read here, so no turn can be tied to its launch." },
      };
    }
    let selection: Awaited<ReturnType<CurrentModelReader["currentPiRecord"]>>;
    try {
      selection = await this.piRecords.currentPiRecord(nodeId, sessionName);
    } catch {
      selection = { ok: false, reason: "the pane's processes could not be read" };
    }
    if (!selection.ok) {
      return {
        emitted: { state: "unknown", detail: `No verified Pi runner for this seat: ${selection.reason}.` },
        observed: { state: "not_verified", detail: `No verified Pi runner for this seat, so no turn can be tied to its launch: ${selection.reason}.` },
      };
    }
    const tokens = processArgv(selection.command);
    const flag = emittedEffortFromArgv("pi", tokens);
    const value = flag.flag === "present" ? flag.value : null;
    // ps joins argv with spaces: a bare word after the value may be the rest of a value with whitespace.
    // Scanned as emittedEffortFromArgv does, so a value is never taken for the flag.
    let after: string | undefined;
    for (let index = 1; index < tokens.length; index += 1) {
      if (tokens[index] === "--thinking") { after = tokens[index + 2]; index += 1; }
      else if (tokens[index]!.startsWith("--thinking=")) after = tokens[index + 1];
    }
    const emitted: EffortReport["emitted"] = value !== null && after !== undefined && !after.startsWith("--")
      ? { state: "unknown", detail: "The launch command's --thinking value can't be read unambiguously (it contains whitespace)." }
      // Compared with what the launch guard sends for the saved value, not the saved value itself.
      : { state: "observed", value, pid: selection.pid, startedAt: selection.startedAt, matchesSaved: value === (piThinkingValue(saved.effective) ?? null) };
    const read = selection.observation;
    if (!read.ok) return { emitted, observed: { state: "not_verified", detail: `No Pi turn from this launch can be read: ${read.reason}.` } };
    if (!read.thinkingLevel) {
      return { emitted, observed: { state: "not_verified", detail: "This Pi doesn't record the thinking level on its turns (Pi 0.99.0 and later do), so the level it ran at can't be shown." } };
    }
    // No flag sent: Pi's level comes from the model suffix or its default, so there is nothing to mismatch.
    return { emitted, observed: {
      state: "observed", value: read.thinkingLevel, at: read.observedAt ?? "unknown time", source: "Pi session (latest successful assistant turn; error and aborted turns are skipped)", outcome: "recorded",
      detail: "Pi recorded this level with the turn's request: the session's level after Pi's own cap, not proof the provider applied it.",
      ...(emitted.state === "observed" && value !== null ? { matchesEmitted: read.thinkingLevel === value } : {}),
    } };
  }

  private lastRequestedEffort(nodeId: string): EffortReport["requested"] {
    const row = this.db.prepare("SELECT payload, created_at FROM events WHERE node_id = ? AND type = 'node.effort_changed' ORDER BY seq DESC LIMIT 1")
      .get(nodeId) as { payload: string; created_at: string } | undefined;
    if (!row) return null;
    try {
      const payload = JSON.parse(row.payload) as { to?: string | null; reason?: string; operator?: string | null };
      return { value: payload.to ?? null, at: row.created_at, reason: payload.reason ?? "", operator: payload.operator ?? null };
    } catch {
      return null;
    }
  }

  /** The transcript of the conversation the observed process is on, or why that join can't be made.
   *  The recorded conversation (Codex: the session's resume token; Claude: the status sidecar's session)
   *  must be the one the process itself names, by argv or, for a Codex that names none, by its own logs. */
  private async joinedTranscript(runtime: "claude-code" | "codex", session: LatestSessionRow, process: { pid: number; command: string; startedAt?: string }):
    Promise<{ path: string | null } | { detail: string }> {
    if (!this.transcripts) return { detail: "The native transcript for this session isn't known to OpenRig." };
    const mismatch = "The process in the pane isn't on the conversation recorded for this seat (or its conversation couldn't be read), so no native turn can be attributed to it.";
    try {
      if (runtime === "codex") {
        const recorded = this.sessionResumeToken(session.id);
        if (!recorded) return { detail: "No Codex conversation is recorded for this session yet." };
        let own = codexCommandResumeToken(process.command) ?? undefined;
        if (own === undefined && process.startedAt) {
          const io = { ...defaultInPlaceRestartIo(), ...this.inPlaceRestartIo };
          const facts = await io.readProcess(process.pid);
          const home = facts?.env.CODEX_HOME ?? (facts?.env.HOME ? nodePath.join(facts.env.HOME, ".codex") : undefined);
          own = home ? await io.readThreadId(process.pid, process.startedAt, home) : undefined;
        }
        if (own !== recorded) return { detail: mismatch };
        return { path: this.transcripts.readCodexTranscriptPath(recorded) };
      }
      const sidecar = this.transcripts.readSidecar(session.session_name);
      if (!sidecar.ok) return { detail: "Claude's status sidecar for this session isn't available, so its transcript isn't known." };
      const recorded = sidecar.data.session_id ?? null;
      const own = claudeCommandSessionToken(process.command);
      // A resumed Claude can rotate to a new session id; the registry's recorded rotation from the
      // launched id to the sidecar's joins them too.
      const rotated = this.db.prepare("SELECT 1 FROM sessions WHERE id = ? AND resume_token = ? AND resume_rotated_from = ?")
        .get(session.id, recorded, own);
      if (!recorded || !own || (own !== recorded && !rotated)) return { detail: mismatch };
      return { path: sidecar.data.transcript_path ?? null };
    } catch {
      return { detail: mismatch };
    }
  }

  private readEffort(nodeId: string): EffortResolution | null {
    let row: { effort: string | null; effort_choice: string | null } | undefined;
    try {
      row = this.db.prepare("SELECT effort, effort_choice FROM nodes WHERE id = ?").get(nodeId) as typeof row;
    } catch {
      return null; // an older database without the columns
    }
    if (!row) return null;
    return resolveSeatEffort({ effort: row.effort, effortChoice: row.effort_choice });
  }

  /** Whether the seat's latest session is live now. Never a guess: an indeterminate probe is unknown. */
  private async runningState(nodeId: string): Promise<{ state: "yes" | "no" | "unknown"; detail?: string }> {
    const session = this.latestSession(nodeId);
    if (!session) return { state: "no", detail: "no session recorded" };
    if (TERMINAL_SESSION_STATUSES.has(session.status)) return { state: "no", detail: `latest session ${session.status}` };
    const probe = await this.probeLiveness(session.session_name, "running is reported as unknown");
    if ("code" in probe) return { state: "unknown", detail: probe.message };
    return probe.state === "present" ? { state: "yes" } : { state: "no", detail: "tmux session absent" };
  }

  async setPermissions(input: { seatRef: string; mode: string; reason: string; actor: string }): Promise<
    | { ok: true; seat: SeatDescriptor; from: unknown; to: unknown; changed: boolean; effect: string }
    | SeatRefusal
  > {
    input = { ...input };
    const required = this.requireReason(input.reason);
    if (required) return required;
    if (!input.actor.trim()) return { ok: false, code: "permission_selection_refused", message: "Sender identity is required for permission audit." };
    const resolved = this.resolveSeat(input.seatRef);
    if ("code" in resolved) return resolved;
    const seat = this.describe(resolved);
    const runtime = resolved.entry.runtime ?? "unknown";
    try {
      const dynamic = runtime === "claude-code" && !["floor", "full_bypass", "inherit"].includes(input.mode);
      const managed = this.runtimeAdapters["claude-code"]?.claudeManagedLaunch;
      if (dynamic && !managed) await unresolvedClaudePermissionModes();
      const launch = dynamic ? await managed!.prepare({ nodeId: seat.nodeId, cwd: resolved.entry.cwd ?? undefined }, input.mode) : null;
      const to = input.mode === "inherit" ? null : dynamic ? { runtime: "claude-code" as const, mode: input.mode }
        : validateNativePermissionSelection(runtime, input.mode);
      const store = new NativePermissionStore(this.db);
      let persisted: PersistedEvent | null = null;
      const result = this.db.transaction(() => {
        launch?.assertCurrent();
        const currentRuntime = this.db.prepare("SELECT runtime FROM nodes WHERE id = ?").get(seat.nodeId) as { runtime: string } | undefined;
        if (currentRuntime?.runtime !== runtime) throw new Error("Seat runtime changed while checking native options; selection was not changed.");
        const from = store.read(seat.nodeId);
        const changed = from?.runtime !== to?.runtime || from?.mode !== to?.mode;
        if (changed) {
          store.write(seat.nodeId, to, input.actor.trim(), input.reason.trim());
          persisted = this.eventBus.persistWithinTransaction({ type: "node.permissions_changed", rigId: seat.rigId,
            nodeId: seat.nodeId, from, to, actor: input.actor.trim(), reason: input.reason.trim(), source: "seat_selection", effect: "future_launches_only" });
        }
        return { ok: true as const, seat, from, to, changed,
          effect: "Future managed launches only. The current native process, history, permission rules and work posture are unchanged; no relaunch was requested." };
      })();
      if (persisted) this.eventBus.notifySubscribers(persisted);
      return result;
    } catch (error) {
      return { ok: false, code: "permission_selection_refused", message: (error as Error).message };
    }
  }

  /** `rig policy apply <name> --seat`: re-point an existing seat's own permission_policy. This writes
   *  the raw ref and the provenance the instantiator would persist for the same member ref; restore,
   *  resume and launches that read the seat's stored state use that provenance, while a launch from a
   *  spec that declares a policy re-applies the spec's. The ref is validated exactly as a spec
   *  member's is; the running process is untouched. */
  async setPolicy(input: { seatRef: string; ref: string; reason: string; actor: string }): Promise<SetPolicyResult> {
    const required = this.requireReason(input.reason);
    if (required) return required;
    const invalid = validatePermissionPolicyRef(input.ref, "permission_policy");
    if (invalid) return { ok: false, code: "invalid_policy", message: invalid };
    const ref = input.ref;
    // Built-ins and `none` resolve from the ref alone; only a custom file reads its declaring directory.
    const attachment = resolvePermissionPolicyAttachment(ref, "", { readFile: () => { throw new Error("no declaring spec"); } });
    if (attachment.origin === "custom") {
      return {
        ok: false, code: "invalid_policy",
        message: `permission_policy: '${ref}' is a custom policy file, which resolves relative to the rig spec that declares it; a seat has no spec directory of its own.`,
        guidance: "Use builtin:<name> or none here, or declare the custom ref in the rig spec.",
      };
    }
    const resolved = this.resolveSeat(input.seatRef);
    if ("code" in resolved) return resolved;
    const seat = this.describe(resolved);
    if (resolved.entry.runtime === "terminal") {
      return { ok: false, code: "invalid_policy", message: "permission_policy: not valid on terminal members (a terminal node is not an agent seat)" };
    }

    const row = this.db.prepare("SELECT permission_policy FROM nodes WHERE id = ?").get(seat.nodeId) as { permission_policy: string | null } | undefined;
    const from = row?.permission_policy ?? null;
    const provenance = {
      origin: attachment.origin,
      resolvedTarget: attachment.resolvedTarget ?? null,
      declaringDir: attachment.declaringDir ?? null,
      launchPosture: attachment.launchPosture,
    };
    const before = this.rigRepo.getNodePolicyProvenance(seat.nodeId);
    const changed = from !== ref || !before || before.origin !== provenance.origin || before.resolvedTarget !== provenance.resolvedTarget
      || before.declaringDir !== provenance.declaringDir || before.launchPosture !== provenance.launchPosture;
    if (changed) {
      let persisted: PersistedEvent | null = null;
      this.db.transaction(() => {
        this.rigRepo.setNodePermissionPolicy(seat.nodeId, ref);
        this.rigRepo.setNodePolicyProvenance(seat.nodeId, provenance);
        persisted = this.eventBus.persistWithinTransaction({
          type: "node.policy_changed", rigId: seat.rigId, nodeId: seat.nodeId, logicalId: seat.logicalId,
          from, to: ref, launchPosture: attachment.launchPosture, reason: input.reason.trim(), operator: input.actor.trim(),
        });
      })();
      if (persisted) this.eventBus.notifySubscribers(persisted);
    }
    let selection = false;
    // An unreadable selection refuses the launch by itself (NativePermissionStore.read); nothing to add here.
    try { selection = new NativePermissionStore(this.db).read(seat.nodeId) !== null; } catch { /* see above */ }
    const effect = "Restore, resume and launches that read this seat's stored state use this policy, unless an explicit native selection (rig seat set-permissions) takes precedence. "
      + "`rig up <rig name>` uses it; a launch from a spec that declares a policy replaces it with the spec's policy, which later restores then use. "
      + "The running process and the rig spec file are unchanged; nothing was restarted."
      + (selection ? " This seat has an explicit native permission selection, so that selection takes precedence at launch." : "");
    return { ok: true, seat, from, to: ref, launchPosture: attachment.launchPosture, changed, effect };
  }

  async stopSeat(input: { seatRef: string; reason: string; operator?: string | null }): Promise<StopSeatResult> {
    const required = this.requireReason(input.reason);
    if (required) return required;
    const resolved = this.resolveSeat(input.seatRef);
    if ("code" in resolved) return resolved;
    const guard = this.tmuxAdapter.deliveryGuard;
    if (guard && !guard.ownsLifecycle(resolved.nodeId)) {
      return guard.lifecycle([resolved.nodeId], () => this.stopSeat(input));
    }
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

    return this.stopManagedTmuxSeat(resolved, session, input.reason, input.operator, true);
  }

  async cleanSeat(input: { seatRef: string; reason: string; operator?: string | null }): Promise<CleanSeatResult> {
    const required = this.requireReason(input.reason);
    if (required) return required;
    const resolved = this.resolveSeat(input.seatRef);
    if ("code" in resolved) return resolved;
    const guard = this.tmuxAdapter.deliveryGuard;
    if (guard && !guard.ownsLifecycle(resolved.nodeId)) {
      return guard.lifecycle([resolved.nodeId], () => this.cleanSeat(input));
    }
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
        const latest = this.latestSession(resolved.nodeId);
        return {
          ok: false,
          code: "session_live",
          message: `Session "${name}" is alive in tmux (checked: tmux has-session, against EVERY session row clean would mutate) — clean only operates on dead seats.`,
          guidance: latest?.session_name === name && latest.origin !== "claimed"
            ? "Stop a live seat first with: rig seat stop"
            : `Check that session (rig capture -- ${shellQuote(name)}) and end it yourself if it is no longer needed, then retry; rig seat stop targets the seat's latest session, not a selected historical session.`,
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
    this.tmuxAdapter.deliveryGuard?.rebindLifecycle(resolved.nodeId);
    if (persisted) this.eventBus.notifySubscribers(persisted);

    return { ok: true, seat, actions: { sessionsExited, bindingCleared: binding !== null } };
  }

  /** Finish context delivery to the same fresh or forked occupant after its native gate.
   * This never launches a process or replays an uncertain/finished delivery.
   */
  async continueStartup(seatRef: string) {
    const resolved = this.resolveSeat(seatRef);
    if ("code" in resolved) return resolved;
    const guard = this.tmuxAdapter.deliveryGuard;
    return guard
      ? guard.lifecycle([resolved.nodeId], () => this.continueStartupUnchecked(seatRef))
      : this.continueStartupUnchecked(seatRef);
  }

  private async continueStartupUnchecked(seatRef: string) {
    const resolved = this.resolveSeat(seatRef);
    if ("code" in resolved) return resolved;
    const seat = this.describe(resolved);
    const node = this.rigRepo.getRig(seat.rigId)?.nodes.find((n) => n.id === seat.nodeId);
    const session = this.latestSession(seat.nodeId);
    const binding = this.sessionRegistry.getBindingForNode(seat.nodeId);
    const pending = session && this.startupOrchestrator?.pendingStartupContext(seat.nodeId, session.id);
    if (!node || !session || !binding?.tmuxSession || !this.startupOrchestrator
      || !pending) {
      return { ok: false as const, code: "continuation_unavailable", message: "No verified pending startup-context delivery exists for this occupant. Refresh to inspect its actual state." };
    }
    const pane = await observeSolePane(this.tmuxAdapter, binding.tmuxSession);
    if (!pane.ok || pane.pane !== binding.tmuxPane) return { ok: false as const, code: "binding_changed", message: "The managed terminal binding changed; context was not delivered." };
    const adapter = seatAdapter(this.runtimeAdapters, node.runtime, session.community_harness);
    if (!adapter) return { ok: false as const, code: "runtime_adapter_missing", message: "The configured runtime adapter is unavailable." };
    const ready = await adapter.checkReady({ ...binding, cwd: node.cwd ?? "." });
    if (!ready.ready) return { ok: false as const, code: "attention_required", message: ready.reason ?? "Resolve the native prerequisite first." };
    const startup = this.readStartupContext(node.id, node.cwd ?? ".");
    if (!startup.ok) return startup.refusal;
    if (startup.context.runtime !== node.runtime) return { ok: false as const, code: "startup_context_runtime_mismatch", message: "The saved startup context belongs to a different runtime." };
    // Recheck after the asynchronous native observation; startNode immediately
    // records pending before its first await, consuming the retained permission.
    if (this.latestSession(node.id)?.id !== session.id || this.sessionRegistry.getBindingForNode(node.id)?.tmuxPane !== pane.pane
      || !this.stillPending(node.id, session.id, pending)) return { ok: false as const, code: "continuation_unavailable", message: "Startup changed during the readiness check. Refresh." };
    const result = await this.startupOrchestrator.startNode({
      rigId: seat.rigId, nodeId: node.id, sessionId: session.id,
      binding: { ...binding, cwd: node.cwd ?? ".", model: node.model ?? undefined, effort: resolveSeatEffort(node).effective ?? undefined, codexConfigProfile: node.codexConfigProfile ?? undefined },
      adapter, plan: startup.context.plan, resolvedStartupFiles: startup.context.resolvedStartupFiles,
      startupActions: startup.context.startupActions, isRestore: pending.mode === "fork" && pending.isRestore,
      sessionName: session.session_name, skipHarnessLaunch: true, continueFreshStartup: pending.mode === "fresh", includeDurableObligations: true, allowFreshFallback: false,
      ...(pending.mode === "fork" ? { forkSource: { kind: "native_id" as const, value: pending.parentToken } } : {}),
    });
    return { ...result, message: result.ok ? "Configured context delivered to the existing conversation." : result.errors.join("; ") };
  }

  /**
   * Resolve a seat snapshot into current launch settings and persisted startup context.
   * Return a refusal for stale seats, unavailable services, or runtime/context mismatch.
   * Reads only: callers receive no reservation or launch guarantee. Execution repeats
   * this resolution under its lifecycle lock rather than trusting an earlier plan.
   */
  private resolveFreshLaunch(resolved: ResolvedSeat, seatRef: string) {
    const seat = this.describe(resolved);
    const rig = this.rigRepo.getRig(seat.rigId);
    const node = rig?.nodes.find((candidate) => candidate.id === seat.nodeId);
    if (!rig || !node) {
      return { ok: false as const, code: "seat_not_found" as const, message: `Seat "${seatRef}" no longer exists.`, guidance: SEAT_LOOKUP_GUIDANCE };
    }
    if (!this.nodeLauncher || !this.startupOrchestrator) {
      return { ok: false as const, code: "launch_unavailable" as const, message: "Fresh-launch services are unavailable in this daemon." };
    }

    const startup = this.readStartupContext(node.id, node.cwd ?? ".");
    if (!startup.ok) return startup.refusal;
    if (!node.runtime || startup.context.runtime !== node.runtime) {
      return {
        ok: false as const,
        code: "startup_context_runtime_mismatch" as const,
        message: `Persisted startup context runtime '${startup.context.runtime}' does not match current node runtime '${node.runtime ?? "missing"}'.`,
      };
    }
    const adapter = seatAdapter(this.runtimeAdapters, node.runtime, this.latestSession(node.id)?.community_harness);
    if (!adapter) {
      return {
        ok: false as const,
        code: "runtime_adapter_missing" as const,
        message: `No runtime adapter is available for '${node.runtime}'.`,
      };
    }

    const canonicalSessionName = deriveCanonicalFromEntry(resolved.entry)
      ?? deriveSessionName(seat.rigName, seat.logicalId);
    return { ok: true as const, resolved, seat, rig, node, adapter, startup: startup.context, canonicalSessionName, nodeLauncher: this.nodeLauncher, startupOrchestrator: this.startupOrchestrator };
  }

  /**
   * Validate an observed canonical collision against current managed rows and binding.
   * `stop` authorizes only this matching occupant; it cannot authorize adopted or
   * mismatched sessions. Return its session row or a refusal, including unknown pane
   * observations, without stopping, repairing, or starting a tmux server.
   */
  /** Whether the context found before the native check is still owed. A fork continuation needs the exact
   *  same pending event: its child is verified against that attempt. A fresh continuation keeps main's
   *  check (fresh context still pending for this occupant), so another pending event doesn't refuse it. */
  private stillPending(nodeId: string, sessionId: string, pending: PendingStartupContext): boolean {
    const now = this.startupOrchestrator?.pendingStartupContext(nodeId, sessionId);
    return pending.mode === "fork" ? now?.eventSeq === pending.eventSeq : now?.mode === "fresh";
  }

  private async validateFreshCollision(resolved: ResolvedSeat, canonicalSessionName: string, stop: boolean): Promise<LatestSessionRow | SeatRefusal> {
    const currentSession = this.latestSession(resolved.nodeId);
    const currentBinding = this.sessionRegistry.getBindingForNode(resolved.nodeId);
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
    if (!stop) {
      return {
        ok: false,
        code: "session_live",
        message: `Seat "${canonicalSessionName}" is live; fresh launch refuses without --stop.`,
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
    return currentSession!;
  }

  /**
   * Check historical rows/bindings that clean would touch, excluding the canonical name.
   * Read-only tmux probes reject adopted, live, or unreadable historical occupants
   * before any stop. Null means no historical blocker was observed; the caller must
   * still validate the canonical occupant and recheck absence before launching.
   */
  private async validateFreshHistory(nodeId: string, canonicalSessionName: string, seatRef: string): Promise<SeatRefusal | null> {
    const rows = this.nonTerminalSessions(nodeId);
    if (rows.some(row => row.origin === "claimed")) {
      return {
        ok: false, code: "claimed_session",
        message: `Seat "${seatRef}" has an adopted/operator-owned occupant; fresh launch refuses even with --stop.`,
        guidance: "Stop the adopted process yourself, then run rig seat clean before launching fresh.",
      };
    }
    const binding = this.sessionRegistry.getBindingForNode(nodeId);
    const names = new Set([...rows.map(row => row.session_name), ...(binding?.tmuxSession ? [binding.tmuxSession] : [])]);
    for (const name of names) {
      if (name === canonicalSessionName) continue;
      const probe = await this.probeLiveness(name, "fresh launch refuses while historical occupant state is unknown");
      if ("code" in probe) return probe;
      if (probe.state === "present") return {
        ok: false, code: "session_live",
        message: `Historical session "${name}" is still live; fresh launch refuses to change this seat.`,
        guidance: "rig seat stop targets the seat's latest session, not a selected historical session; it may stop the current occupant instead.",
      };
    }
    return null;
  }

  /**
   * Snapshot one seat's proposed fresh launch; `fresh` is mandatory and `stop` is intent.
   * No lifecycle lock, repair, material projection, native launch or persistent write
   * is entered. Siblings are listed as unchanged; no seat is reserved by the result.
   * Known blockers set launchable=false; otherwise incomplete observations yield null.
   * Unreadable tmux remains incomplete, never readiness. No launch command is built.
   * Errors are reduced to safe codes;
   * startup text, credentials and process output are not included in the response.
   */
  async planFresh(input: { seatRef: string; fresh: boolean; stop?: boolean }) {
    const refusal = (error: SeatRefusal) => ({
      ...error, planOnly: true as const, complete: error.code !== "tmux_probe_failed", launchable: false as const,
      // Parser/probe errors can embed persisted startup content or process output.
      message: `Fresh launch preview refused: ${error.code}.`,
    });
    if (!input.fresh) return refusal({ ok: false, code: "fresh_required", message: "--plan requires --fresh." });
    const resolved = this.resolveSeat(input.seatRef);
    if ("code" in resolved) return refusal(resolved);
    const prepared = this.resolveFreshLaunch(resolved, input.seatRef);
    if ("code" in prepared) return refusal(prepared);
    const { seat, rig, node, startup, canonicalSessionName } = prepared;
    const blockers: Array<{ code: string; message: string; guidance?: string }> = [];
    const warnings = ["Snapshot only; execution resolves and validates again. Native readiness is not checked."];
    let complete = true;
    let tmuxUnknown = false;
    const guard = this.tmuxAdapter.deliveryGuard?.preference(node.id);
    if (guard?.effective || guard?.desired) blockers.push({ code: "typing_guard_enabled", message: "Typing protection blocks lifecycle operations for this seat." });
    const record = (error: SeatRefusal) => {
      if (error.code === "tmux_probe_failed") {
        complete = false;
        tmuxUnknown = true;
        warnings.push("tmux state is unknown; no server was started and no occupant was changed.");
      } else if (error.code === "claimed_session" || error.code === "session_live") {
        blockers.push({ code: error.code, message: error.message, guidance: error.guidance });
      } else blockers.push({ code: error.code, message: `Fresh launch would be refused: ${error.code}.` });
    };
    const history = await this.validateFreshHistory(node.id, canonicalSessionName, input.seatRef);
    if (history) record(history);
    const probe = await this.probeLiveness(canonicalSessionName, "preview does not repair tmux");
    const currentOccupant = "code" in probe ? "unknown" : probe.state;
    let stopRequired: boolean | null = currentOccupant === "absent" ? false : null;
    let owned = false;
    if ("code" in probe) record(probe);
    else if (probe.state === "present") {
      // Check ownership even without --stop; presence alone is not permission to stop.
      const collision = await this.validateFreshCollision(resolved, canonicalSessionName, true);
      if ("code" in collision) record(collision);
      else {
        owned = true;
        stopRequired = true;
        if (!input.stop) blockers.push({ code: "session_live", message: "A live managed occupant requires --stop." });
      }
    }
    const launchable = blockers.length > 0 ? false : complete ? true : null;
    const siblings = rig.nodes.filter(n => n.id !== node.id).map(n => ({
      logicalId: n.logicalId, sessionName: n.binding?.tmuxSession ?? null, effect: "unchanged" as const,
    }));
    return {
      ok: true as const, planOnly: true as const, complete, launchable, seat,
      sessionName: canonicalSessionName, currentOccupant,
      stopRequired, wouldStop: blockers.length > 0 ? false : tmuxUnknown ? null : owned && input.stop === true,
      blockers, warnings, siblings,
      startup: { projectionCount: startup.plan.entries.length,
        fileCount: startup.resolvedStartupFiles.filter(f => f.appliesOn.includes("fresh_start")).length,
        actionCount: startup.startupActions.filter(a => a.appliesOn.includes("fresh_start")).length },
    };
  }

  /**
   * Execute a fresh replacement of exactly one seat, requiring fresh intent and reason.
   * Resolve configuration again under the lifecycle lock, reject unsafe historical or
   * canonical occupants, and require positive absence before creating a new occupant.
   * Unlike planFresh this mutates lifecycle/startup state; an earlier preview grants
   * no authority to skip validation. Sibling seats are never included in the operation.
   */
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
    const guard = this.tmuxAdapter.deliveryGuard;
    if (guard && !guard.ownsLifecycle(resolved.nodeId)) {
      return guard.lifecycle([resolved.nodeId], () => this.launchFresh(input));
    }
    const prepared = this.resolveFreshLaunch(resolved, input.seatRef);
    if ("code" in prepared) return prepared;
    const { seat, node, adapter, startup, canonicalSessionName, nodeLauncher, startupOrchestrator } = prepared;
    const historyRefusal = await this.validateFreshHistory(resolved.nodeId, canonicalSessionName, input.seatRef);
    if (historyRefusal) return historyRefusal;
    const retiringRows = this.nonTerminalSessions(node.id);
    // Detached is terminal for process cleanup, but remains a reboot candidate.
    // A deliberate fresh launch must retire that prior history as well.
    const supersededSessionIds = (this.db.prepare(
      "SELECT id FROM sessions WHERE node_id = ? AND status NOT IN ('superseded', 'exited')",
    ).all(node.id) as Array<{ id: string }>).map((row) => row.id);
    const retiringGeneration = this.sessionRegistry.currentOccupantTenure(node.id)?.generationUuid ?? null;

    let canonicalProbe = await this.probeLiveness(
      canonicalSessionName,
      "fresh launch refuses rather than overwrite a possibly-live canonical session",
    );
    // `rig seat stop` persists an exited row after killing its managed session.
    // When that was the last tmux session, tmux exits too, so the next classified
    // probe sees unavailable transport instead of positive absence. Reopen an
    // empty server only when the persisted state proves this seat's managed
    // occupant was deliberately stopped and no other managed row remains live.
    // The probe below still decides absence; a recreated session or failed
    // transport remains a refusal.
    if ("code" in canonicalProbe) {
      const latest = this.latestSession(node.id);
      const hasCurrentBinding = this.sessionRegistry.getBindingForNode(node.id) !== null;
      const stoppedManagedOccupant = latest !== null
        && latest.session_name === canonicalSessionName
        && latest.status === "exited"
        && latest.origin !== "claimed"
        && !hasCurrentBinding
        && this.nonTerminalSessions(node.id).length === 0;
      if (stoppedManagedOccupant) {
        try {
          const restored = await this.tmuxAdapter.startServer();
          if (restored.ok) {
            canonicalProbe = await this.probeLiveness(
              canonicalSessionName,
              "fresh launch refuses rather than overwrite a possibly-live canonical session",
            );
          }
        } catch {
          // Keep the original classified refusal when the transport cannot be
          // restored; never translate a failed start into absence.
        }
      }
    }
    if ("code" in canonicalProbe) return canonicalProbe;
    if (canonicalProbe.state === "present") {
      const currentSession = await this.validateFreshCollision(resolved, canonicalSessionName, input.stop === true);
      if ("code" in currentSession) return currentSession;
      const stopped = await this.stopManagedTmuxSeat(
        resolved,
        currentSession,
        input.reason,
        input.operator,
        false,
      );
      if (!stopped.ok) return stopped;
      // Stopping the server's last session ends tmux's server, and every probe
      // below would then be transport_unavailable, never absence. Restore an
      // empty server (no session is invented; a no-op while the server is up)
      // so they get a positive answer. The classified probes still decide.
      await this.tmuxAdapter.startServer();
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

    const launch = await nodeLauncher.launchNode(seat.rigId, seat.logicalId, {
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
        startupPolicyHash: startup.hash,
        model: node.model,
        effort: resolveSeatEffort(node).effective,
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
    const startupResult = await startupOrchestrator.startNode({
      rigId: seat.rigId,
      nodeId: node.id,
      sessionId: launch.session.id,
      binding: {
        ...launch.binding,
        cwd: node.cwd ?? ".",
        model: node.model ?? undefined,
        effort: resolveSeatEffort(node).effective ?? undefined,
        codexConfigProfile: node.codexConfigProfile ?? undefined,
        launchPosture,
      },
      adapter,
      plan: startup.plan,
      resolvedStartupFiles: startup.resolvedStartupFiles,
      startupActions: startup.startupActions,
      isRestore: false,
      includeDurableObligations: true,
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
        startupPolicyHash: startup.hash,
        model: node.model,
        effort: resolveSeatEffort(node).effective,
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
            warnings: startupResult.warnings,
          }
        : {
            ok: false,
            code: "attention_required",
            status: "attention_required",
            message: `Fresh startup failed and the new process could not be confirmed stopped; the seat requires attention: ${startupResult.errors.join("; ")}`,
            warnings: startupResult.warnings,
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
      listProcesses: this.listProcesses,
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
        effort: resolveSeatEffort(node).effective,
        startupPolicyHash: startup.hash,
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
        warnings: startupResult.warnings,
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
      effort: resolveSeatEffort(node).effective ?? undefined,
      startupPolicyHash: startup.hash,
      supersededSessionIds,
      warnings: startupResult.warnings,
    };
  }

  /**
   * OPR.0.7.0.5 — restart one Codex seat in place so it reads its home's current account: same conversation,
   * same pane, the settings it is running with now. `plan` runs every gate read-only. Activity (mid-turn,
   * needs input) and child processes are reported for the operator to judge, not refused. Identity, typing
   * guard, adopted sessions, unreadable tmux and settings drift are named refusals before any signal.
   */
  async restartInPlace(input: { seatRef: string; reason?: string; plan?: boolean; operator?: string | null }): Promise<RestartInPlaceResult> {
    if (!input.plan) {
      const required = this.requireReason(input.reason ?? "");
      if (required) return required;
    }
    const resolved = this.resolveSeat(input.seatRef);
    if ("code" in resolved) return resolved;
    const prepared = this.inPlaceRestarter();
    if ("code" in prepared) return prepared;
    if (input.plan) {
      const target = await this.inPlaceTarget(resolved, input.seatRef);
      return "code" in target ? target : prepared.plan(target);
    }
    // Recorded before waiting for the lease: a restart that ran meanwhile refuses this one (no repeat
    // on a slow reply).
    const seenStartedSeq = prepared.latestStartedSeq(resolved.nodeId);
    const run = async (): Promise<RestartInPlaceResult> => {
      const target = await this.inPlaceTarget(resolved, input.seatRef);
      if ("code" in target) return target;
      return prepared.execute(target, { reason: input.reason ?? "", operator: input.operator ?? null, seenStartedSeq });
    };
    const guard = this.tmuxAdapter.deliveryGuard;
    return guard && !guard.ownsLifecycle(resolved.nodeId) ? guard.lifecycle([resolved.nodeId], run) : run();
  }

  /** `--verify`: report `moved` only with a completed tool turn since the restart and account-specific evidence. */
  async verifyRestartInPlace(input: { seatRef: string; expectAccount?: string | null }): Promise<VerifyRestartInPlaceResult> {
    const resolved = this.resolveSeat(input.seatRef);
    if ("code" in resolved) return resolved;
    const prepared = this.inPlaceRestarter();
    if ("code" in prepared) return prepared;
    const target = await this.inPlaceTarget(resolved, input.seatRef);
    return "code" in target ? target : prepared.verify(target, { expectAccount: input.expectAccount ?? null });
  }

  private inPlaceRestarter(): CodexInPlaceRestart | SeatRefusal {
    const adapter = this.runtimeAdapters["codex"] as (RuntimeAdapter & Partial<InPlaceCodexLauncher>) | undefined;
    if (!adapter?.buildResumeCommand || !adapter.verifyResumeInPane || !adapter.sendResumeCommand) {
      return { ok: false, code: "runtime_adapter_missing", message: "The Codex runtime adapter with in-place resume is unavailable in this daemon." };
    }
    const activity = this.activityOracle?.getSeatState ? this.activityOracle as { getSeatState(nodeId: string): ArbitratedSeatState | null } : null;
    return new CodexInPlaceRestart({
      db: this.db, sessionRegistry: this.sessionRegistry, eventBus: this.eventBus, tmux: this.tmuxAdapter,
      codex: adapter as InPlaceCodexLauncher, activity, listProcesses: this.listProcesses,
      io: this.inPlaceRestartIo, timing: this.inPlaceRestartTiming, daemonStartedAt: this.inPlaceRestartDaemonStartedAt,
    });
  }

  /** The shared seat refusals, then the binding the relaunch is built from (the handover's posture rules). */
  private async inPlaceTarget(resolved: ResolvedSeat, seatRef: string): Promise<InPlaceRestartTarget | SeatRefusal> {
    const seat = this.describe(resolved);
    const node = this.rigRepo.getRig(seat.rigId)?.nodes.find((candidate) => candidate.id === seat.nodeId);
    if (!node) return { ok: false, code: "seat_not_found", message: `Seat "${seatRef}" no longer exists.`, guidance: SEAT_LOOKUP_GUIDANCE };
    if (node.runtime !== "codex") {
      return { ok: false, code: "not_codex", message: `Seat "${seatRef}" runs ${node.runtime ?? "an unknown runtime"}; in-place restart supports Codex seats only.` };
    }
    const preference = this.tmuxAdapter.deliveryGuard?.preference(node.id);
    if (preference?.effective || preference?.desired) {
      return { ok: false, code: "typing_guard_enabled", message: "Typing protection blocks lifecycle operations for this seat; nothing was restarted." };
    }
    const session = this.latestSession(node.id);
    if (!session || TERMINAL_SESSION_STATUSES.has(session.status)) {
      return { ok: false, code: "no_session", message: `Seat "${seatRef}" has no live managed session to restart (checked: latest sessions row).` };
    }
    if (session.origin === "claimed") {
      return { ok: false, code: "claimed_session", message: `Session "${session.session_name}" was adopted (origin=claimed), not launched by OpenRig; in-place restart refuses it.`,
        guidance: "Release an adopted session with: rig unclaim" };
    }
    const probed = await this.probeLiveness(session.session_name, "in-place restart refuses rather than act on an unknown session");
    if ("code" in probed) return probed;
    if (probed.state === "absent") {
      return { ok: false, code: "session_not_live", message: `Session "${session.session_name}" is absent in tmux; there is nothing to restart in place.` };
    }
    const binding = this.sessionRegistry.getBindingForNode(node.id);
    if (!binding?.tmuxSession || binding.tmuxSession !== session.session_name || !binding.tmuxPane) {
      return { ok: false, code: "session_not_live", message: `Seat "${seatRef}" has no bound tmux pane for session "${session.session_name}".` };
    }
    let permissionOverride: ReturnType<NativePermissionStore["launchOverride"]>;
    try {
      permissionOverride = new NativePermissionStore(this.db).launchOverride(node.id, "codex");
    } catch (error) {
      return { ok: false, code: "permission_selection_refused", message: `Permission selection: ${(error as Error).message}` };
    }
    const launchPosture = permissionOverride.launchPosture
      ?? this.rigRepo.getNodePolicyProvenance(node.id)?.launchPosture
      ?? this.rigRepo.getRigPolicyProvenance(seat.rigId)?.launchPosture
      ?? "floor";
    // OPR.0.7.0.7: an in-place restart is a managed continuation, so it relaunches with the seat's saved effort.
    const savedEffort = resolveSeatEffort(node);
    return {
      seat, sessionId: session.id, sessionName: session.session_name,
      saved: { model: node.model ?? null, effort: savedEffort.effective, codexConfigProfile: node.codexConfigProfile ?? null, effortSource: savedEffort.source },
      binding: {
        ...binding, cwd: node.cwd ?? ".",
        ...(node.model ? { model: node.model } : {}),
        ...(savedEffort.effective ? { effort: savedEffort.effective } : {}),
        ...(node.codexConfigProfile ? { codexConfigProfile: node.codexConfigProfile } : {}),
        launchPosture, kernelAuthority: permissionOverride.kernelAuthority, teamPermissionDefault: permissionOverride.teamPermissionDefault,
        nonInterruptive: this.rigRepo.getRigNonInterruptive(seat.rigId),
      },
    };
  }

  // -- shared internals --

  private async stopManagedTmuxSeat(
    resolved: ResolvedSeat,
    session: LatestSessionRow,
    reason: string,
    operator: string | null | undefined,
    recordStopIntent: boolean,
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
      if (recordStopIntent && kill?.ok) {
        this.sessionRegistry.markIntentionallyStopped(session.id);
      } else {
        // An internal replacement stop or an unconfirmed kill must still affect health.
        this.sessionRegistry.updateStatus(session.id, "exited");
      }
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
    this.tmuxAdapter.deliveryGuard?.rebindLifecycle(resolved.nodeId);
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
      // #261: shipped-spec resources follow the running install.
      entries.push(reanchorShippedProjectionEntry({
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
      }));
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
      // #261: recognized built-in startup files follow the running install.
      resolvedStartupFiles.push(reanchorBuiltinStartupFile({
        path: raw["path"],
        absolutePath: raw["absolutePath"],
        ownerRoot: raw["ownerRoot"],
        deliveryHint: raw["deliveryHint"],
        required: raw["required"],
        appliesOn: raw["appliesOn"],
        ...(raw["kind"] === "file" ? { kind: "file" as const } : {}),
      }));
    }

    const startupActions: StartupAction[] = [];
    for (const raw of rawActions) {
      if (!isRecord(raw)
        || !isOneOf(raw["type"], ["slash_command", "send_text", "startup_proof"] as const)
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

    try {
      resolveStartupProof(startupActions, "fresh_start");
    } catch (err) {
      return this.malformedStartupContext(nodeId, (err as Error).message);
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
    effort?: string | null;
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
        effort: input.effort ?? null,
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
      `SELECT id, session_name, status, origin, ${sessionCommunityHarnessSelect(this.db, "sessions")} AS community_harness FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1`,
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
      const rigs = this.rigRepo.findUnarchivedRigsByName(parsed.rig);
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

/** One line naming where the four values agree, and where they can't be seen. */
function effortSummary(saved: EffortResolution, emitted: EffortReport["emitted"], observed: EffortReport["observed"], runtime: string): string {
  const savedText = saved.effective ? `${saved.effective} (${saved.source === "seat_choice" ? "seat choice" : "authored"})` : "no flag (the runtime's own default)";
  if (emitted.state !== "observed") {
    // Only a Pi launch value that can't be read back unambiguously leaves the native turn readable.
    const native = observed.state === "observed" ? `${observed.value} (${observed.source}, ${observed.at})` : "NOT VERIFIED";
    return `Saved: ${savedText}. Launch: unknown (${emitted.detail}) Native effort: ${native}.`;
  }
  const launch = emitted.value ?? "no flag";
  // A Pi saved value the launch guard leaves out never applies, so it isn't reported as pending.
  const launchNote = runtime === "pi" && saved.effective && !piThinkingValue(saved.effective) ? " The saved value isn't sent: it doesn't pass the check set-effort uses (a letter, then up to 31 letters, digits, - or _)."
    : emitted.matchesSaved ? "" : " This differs from the saved value: it applies at the seat's next managed continuation.";
  if (observed.state !== "observed") return `Saved: ${savedText}. Launch sent: ${launch}.${launchNote} Native effort: NOT VERIFIED (${observed.detail})`;
  const sent = observed.matchesEmitted !== false ? observed.value
    : runtime === "pi" ? `${observed.value}, not the ${launch} sent at launch (Pi caps a level the model doesn't offer, ignores one it doesn't know, and the level can change inside the session)`
    : `${observed.value}, not the ${launch} the launch sent (changed or overridden inside the session)`;
  const verdict = observed.outcome === "accepted" ? "accepted by the service for that turn"
    : observed.outcome === "rejected" ? `REJECTED (${observed.detail})`
    : observed.outcome === "failed" || observed.outcome === "interrupted" ? (observed.detail ?? "not judged").replace(/\.$/, "")
    : observed.outcome === "pending" ? "its turn hasn't finished, so not yet known whether it was taken"
    : runtime === "pi" ? "applied level NOT VERIFIED (Pi records the level it requested, not what the provider ran)"
    : "applied level NOT VERIFIED (whether this is after any model fallback isn't shown)";
  return `Saved: ${savedText}. Launch sent: ${launch}.${launchNote} The session sent ${sent} with its latest turn (${observed.source}, ${observed.at}): ${verdict}.`;
}
