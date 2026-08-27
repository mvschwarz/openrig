import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { DiscoveryRepository } from "./discovery-repository.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { TmuxOptionDefaultsApplier } from "./tmux-option-defaults.js";
import { SeatStatusService, type SeatStatus, type SeatStatusResult } from "./seat-status-service.js";
import { SeatHandoverPlanner, parseHandoverSource, SEAT_HANDOVER_SOURCE_CAPABILITIES, type SeatHandoverPlan, type SeatHandoverSource } from "./seat-handover-planner.js";
import { discoverResumeToken } from "./agent-images/resume-token-discovery.js";
import { resolveRebuildArtifacts } from "./session-source-rebuild-resolver.js";
import { existsSync } from "node:fs";
import { SuccessorSessionLauncher } from "./successor-session-launcher.js";
import { deriveResumeToken, type ResumeTokenCaptureDeps } from "./resume-token-capture.js";
import { validateResumeToken } from "./resume-token-validation.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";
import type { OccupantInvalidator } from "./occupant-invalidator.js";
import type { JsonlExchange } from "./session-jsonl.js";
import type { PersistedEvent } from "./types.js";
import type { AppliedLaunchObservation } from "./permission-drift.js";
import { AppliedLaunchObservationStore } from "./applied-launch-observation-store.js";

/** A bounded labeled-from-record recap of the predecessor's last exchanges + the record path,
 *  resolved from the predecessor's provider transcript (claude transcript_path / codex rollout_path).
 *  The permanent claude-runtime leg of scrollback preservation (alternate-screen seats keep no
 *  native scrollback); renders on codex seats too, where native scrollback is the money proof. */
export interface PredecessorRecap {
  recap: JsonlExchange[];
  recordPath: string;
}
/** B16 — every no-recap outcome is NAMED: the resolver returns either the recap or the reason it
 *  is unavailable, and the packet prints that reason (honest-degraded means labeled, not silent). */
export type PredecessorRecapResolution = PredecessorRecap | { unavailableReason: string };

/** Resolve the predecessor's bounded recap for the successor boot packet, or a named unavailable
 *  verdict (never a silent null — the packet renders the reason). */
export type PredecessorRecapResolver = (args: {
  nodeId: string;
  runtime: string | null;
  sessionName: string;
}) => PredecessorRecapResolution;

export interface SeatHandoverMutationResult {
  ok: true;
  dryRun: false;
  mutated: true;
  continuityTransferred: false;
  seat: SeatHandoverPlan["seat"];
  // The source reported to the operator is the ORIGINAL intent
  // (fresh/rebuild/fork/discovered). Non-discovered sources are internally
  // routed through a created discovery candidate, but provenance stays honest.
  source: SeatHandoverSource;
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
    startupContextDelivered: boolean;
    provenanceRecordWritten: false;
  };
  /** OPR.0.5.5.5 — per-source execution outcome. fork: the resolved fork origin;
   *  rebuild: EXACTLY which durable artifacts primed the successor, which
   *  declared addresses were gaps, and (when the chain is empty) the named
   *  reason — recorded, never silently dropped. Absent for fresh/discovered. */
  sourceOutcome?:
    | { mode: "fork"; forkedFrom: string }
    | { mode: "rebuild"; primedArtifacts: Array<{ address: string; label: string }>; gaps: string[]; emptyChainReason?: string };
}

export type SeatHandoverResult =
  | { ok: true; plan: SeatHandoverPlan }
  | { ok: true; result: SeatHandoverMutationResult }
  | { ok: false; code: "missing_reason" | "invalid_source" | "successor_creation_not_implemented" | "source_not_supported" | "resume_token_unavailable" | "fork_source_not_found"; message: string; guidance: string }
  | { ok: false; code: "current_occupant_required" | "discovered_not_active" | "successor_tmux_absent" | "successor_already_managed" | "successor_is_current" | "runtime_mismatch"; message: string; guidance: string }
  | { ok: false; code: "discovered_not_found"; message: string; guidance: string }
  | { ok: false; code: "tmux_probe_failed" | "handover_commit_failed" | "successor_create_failed" | "context_delivery_failed"; message: string; guidance: string }
  | Extract<SeatStatusResult, { ok: false }>;

interface NodeRow {
  id: string;
  runtime: string | null;
  cwd: string | null;
  // 0.5.2-07: the seat's SPEC-pinned model, threaded onto the successor binding so handover
  // does not silently revert a spec-pinned seat to the runtime default (adapter emits -m/--model).
  model: string | null;
  // 0.5.2-07 A4-profile: the seat's SPEC-pinned codex config profile (nodes.codex_config_profile),
  // threaded onto the successor binding for the same reason as model — the adapter emits `-p <profile>`.
  codex_config_profile: string | null;
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
  /** OpenRig identity/activity env stamped onto a created successor session,
   *  mirroring the launch identity env. Defaults to {} (the three core identity
   *  vars are always derived internally). */
  sessionEnv?: Record<string, string | undefined>;
  /** Injectable id source for the successor session name (tests). */
  newSuccessorId?: () => string;
  /** Runtime adapters keyed by runtime — used to launch a fresh successor into
   *  a LIVE agent (B1) before commit. Absent → fresh handover cannot launch. */
  runtimeAdapters?: Record<string, RuntimeAdapter>;
  /** Claude sidecar reader for discovered-mode resume-token capture (B2). */
  contextUsageStore?: ResumeTokenCaptureDeps["contextUsageStore"];
  /** Codex thread-id capturer for discovered-mode resume-token capture (B2). */
  resumeTokenCapturer?: ResumeTokenCaptureDeps["resumeTokenCapturer"];
  /** OPR.0.4.6.PI1 FR-6 — pi-runner sidecar reader for Pi resume-token capture. */
  piRunnerStateStore?: ResumeTokenCaptureDeps["piRunnerStateStore"];
  /** Readiness timeout for the successor launch (tests shorten it). */
  readinessTimeoutMs?: number;
  /** Injectable sleep for the successor readiness backoff (tests). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * OPR.0.4.6.02 S1 — the SHARED tmux option-defaults applier, threaded into
   * the successor launcher so a FRESH handover successor gets the same
   * mouse/status/clipboard defaults as a NodeLauncher-launched seat.
   */
  tmuxOptionDefaults?: TmuxOptionDefaultsApplier;
  /**
   * Ghost-stage (e) seam — the per-store retiring-occupant invalidator, authored by the ghost-stage
   * slice and CALLED once at commit() so the cutover successor never inherits a predecessor's seat-name-
   * keyed state. Optional: absent until the ghost-stage slice lands → the commit call is skipped (never
   * blocking the handover). See occupant-invalidator.ts.
   */
  occupantInvalidator?: OccupantInvalidator;
  /**
   * Resolves the predecessor's bounded from-record recap for the successor boot packet (claude
   * transcript_path / codex rollout_path → parseJsonlExchanges). Optional: absent → the recap
   * sections are omitted honestly. The recap is the permanent claude-runtime leg of scrollback
   * preservation (alternate-screen seats keep no native scrollback); on codex seats the preserved
   * native scrollback is the money proof. Wired in production to ContextUsageStore + parseJsonlExchanges.
   */
  predecessorRecapResolver?: PredecessorRecapResolver;
  /**
   * OPR.0.5.3.5 mini-req 7 — resolves the AUTHORED seat recap (RECAP.md beside LEARNED, written by
   * the outgoing occupant) for the successor packet's pointer leg. Optional: absent -> the authored
   * leg is omitted (the feature never ran); a resolver that finds nothing returns the labeled
   * absence. Wired in production to seat-recap-store + the topology.root seat layout.
   */
  authoredRecapResolver?: (seatRef: string) => { address: string; chainLength: number } | { absentReason: string };
  /**
   * S19 (territory ruling qitem-20260827001530, EXACT bounds): ONE narrow call into the
   * activity oracle at the completion/rebind commit point so seat-keyed activity state
   * treats the cutover as its own visible event and the successor's rung inventory
   * starts unpromoted (never inheriting the retiree's rung authority). Optional: absent
   * → skipped, never blocks a handover.
   */
  activityOracle?: { declareOccupantSwap: (seatNodeId: string, generation: string) => void };
  /**
   * OPR.0.5.5.5 — resolves the seat's durable rebuild-priming chain (authored
   * recap chain, LEARNED, restore-packet record) in trust-precedence order for
   * `--source rebuild`. Optional: absent → rebuild executes with a named empty
   * chain. Wired in production to seat-recap-store (listRecapChain) + the
   * topology.root seat layout.
   */
  rebuildPrimingResolver?: (seatRef: string) => { artifacts: Array<{ address: string; label: string }> } | { emptyReason: string };
  /** OPR.0.5.5.5 — filesystem existence check for declared rebuild artifacts
   *  (the session-source-rebuild-resolver seam). Default: node:fs existsSync;
   *  tests inject. */
  rebuildArtifactExists?: (path: string) => boolean;
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
  private successorLauncher: SuccessorSessionLauncher;
  private captureDeps: ResumeTokenCaptureDeps;
  private occupantInvalidator: OccupantInvalidator | null;
  private predecessorRecapResolver: PredecessorRecapResolver | null;
  private authoredRecapResolver: SeatHandoverServiceDeps["authoredRecapResolver"] | null;
  private activityOracle: SeatHandoverServiceDeps["activityOracle"] | null;
  private rebuildPrimingResolver: SeatHandoverServiceDeps["rebuildPrimingResolver"] | null;
  private rebuildArtifactExists: (path: string) => boolean;
  /** Injectable sleep (tests): also carries the shared paste-then-submit settle in deliverRestorePacket. */
  private sleep: (ms: number) => Promise<void>;
  private appliedLaunchObservations: AppliedLaunchObservationStore;
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
    this.occupantInvalidator = deps.occupantInvalidator ?? null;
    this.activityOracle = deps.activityOracle ?? null;
    this.predecessorRecapResolver = deps.predecessorRecapResolver ?? null;
    this.authoredRecapResolver = deps.authoredRecapResolver ?? null;
    this.rebuildPrimingResolver = deps.rebuildPrimingResolver ?? null;
    this.rebuildArtifactExists = deps.rebuildArtifactExists ?? existsSync;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.appliedLaunchObservations = new AppliedLaunchObservationStore(deps.db);
    this.now = deps.now ?? (() => new Date());
    this.statusService = new SeatStatusService({ rigRepo: deps.rigRepo });
    this.planner = new SeatHandoverPlanner({ rigRepo: deps.rigRepo });
    this.successorLauncher = new SuccessorSessionLauncher(deps.tmuxAdapter, deps.discoveryRepo, {
      sessionEnv: deps.sessionEnv,
      newId: deps.newSuccessorId,
      runtimeAdapters: deps.runtimeAdapters,
      readinessTimeoutMs: deps.readinessTimeoutMs,
      sleep: deps.sleep,
      tmuxOptionDefaults: deps.tmuxOptionDefaults,
    });
    this.captureDeps = {
      contextUsageStore: deps.contextUsageStore ?? null,
      resumeTokenCapturer: deps.resumeTokenCapturer ?? null,
      piRunnerStateStore: deps.piRunnerStateStore ?? null,
    };
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
    // OPR.0.5.5.5 — execution dispatches on the SAME capability table the
    // dry-run plan renders from, so the plan can never promise a source the
    // executor refuses. Every current mode executes; a future non-executing
    // mode must declare `executes: false` in its table row to be refused here.
    if (!SEAT_HANDOVER_SOURCE_CAPABILITIES[parsed.source.mode].executes) {
      return {
        ok: false,
        code: "source_not_supported",
        message: `${parsed.source.mode} handover does not execute on this daemon.`,
        guidance: "Use a source the dry-run plan marks executable.",
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

    const operator = input.operator?.trim() || null;

    // OPR.0.5.5.5 fork: resolve the native conversation id BEFORE any mutation
    // (the respawn), so a missing/undiscoverable token is an honest pre-mutation
    // refusal — never a blank successor silently reported as a fork, and never a
    // mid-swap abort for a condition knowable up front.
    let forkSource: { kind: "native_id"; value: string } | null = null;
    if (parsed.source.mode === "fork") {
      const forkRef = parsed.source.ref ?? latestSession.session_name;
      const discovery = discoverResumeToken(this.db, forkRef);
      if (!discovery.ok) {
        return {
          ok: false,
          code: discovery.failure.code === "session_not_found" ? "fork_source_not_found" : "resume_token_unavailable",
          message: discovery.failure.message,
          guidance: "Fork needs a resolvable native conversation id. Inspect the source session with: rig ps --nodes",
        };
      }
      if (!discovery.result.nativeId) {
        return {
          ok: false,
          code: "resume_token_unavailable",
          message: `No native resume id is discoverable for fork source "${forkRef}" — the conversation may not have produced output yet. No successor was created and the seat is untouched.`,
          guidance: "Retry after the source session has a native conversation id, or use --source fresh.",
        };
      }
      if (node.runtime && discovery.result.runtime && node.runtime !== discovery.result.runtime) {
        return {
          ok: false,
          code: "runtime_mismatch",
          message: `Seat expects runtime "${node.runtime}", but fork source "${forkRef}" is "${discovery.result.runtime}".`,
          guidance: "Fork from a source session that runs the seat's runtime.",
        };
      }
      forkSource = { kind: "native_id", value: discovery.result.nativeId };
    }

    // Already-created successor: route straight through the discovered->commit
    // path with nothing to unwind (byte-identical to the shipped behavior).
    if (parsed.source.mode === "discovered" && parsed.source.ref) {
      return this.finalizeWithDiscovered({
        seatRef: input.seatRef,
        status: statusResult.status,
        node,
        latestSession,
        discoveredRef: parsed.source.ref,
        reportedSource: parsed.source,
        reason,
        operator,
        contextDelivered: false,
        launchToken: null,
        occupantGeneration: null,
        appliedLaunch: null,
        cleanup: null,
      });
    }

    // Full-cycle composer for fresh (CUTOVER): capture -> respawn a live successor INTO the departing
    // pane in place -> deliver captured context -> verify continuity -> rebind. The registry BINDING is
    // untouched until the commit inside finalizeWithDiscovered (the SOLE, LAST rebind), but the retiree
    // PROCESS is force-replaced at the in-place respawn (it exits in place; its provider session file is
    // the durable wake target). (fork/rebuild were rejected above; discovered was finalized above.)

    // 1. Capture the departing seat's context BEFORE the respawn replaces it.
    const capturedContext = await this.captureDepartingContext(latestSession.session_name);
    const predecessorGeneration = this.sessionRegistry.currentOccupantTenure(node.id)?.generationUuid;

    // 1b. B16 — resolve the predecessor's from-record recap NOW, before the successor exists: the
    // claude sidecar is keyed by SESSION NAME and the cutover reuses the canonical name, so once the
    // successor harness boots it overwrites the very sidecar the resolver reads (the live defect:
    // the resolver ran post-launch, read the successor's fresh sidecar, and honestly found nothing —
    // silently). Resolution is a pure read; nothing downstream of it depends on the launch.
    const rawRecapResolution = this.predecessorRecapResolver
      ? this.predecessorRecapResolver({ nodeId: node.id, runtime: node.runtime, sessionName: latestSession.session_name })
      : undefined;
    // Defensive against the pre-B16 resolver contract (null = silent no-recap): an injected legacy
    // resolver must not crash the handover — its null becomes a named unavailable like every other.
    const predecessorRecapResolution: PredecessorRecapResolution =
      rawRecapResolution ?? { unavailableReason: this.predecessorRecapResolver ? "recap resolver returned no result" : "no recap resolver wired on this daemon" };

    // 2. Respawn the successor INTO the retiree's pane and launch it into a LIVE, READY agent (§2.1b
    //    seam, B1): resolve departing pane -> respawn-pane in place (preserved name) -> real runtime
    //    startup (launchHarness + readiness) -> upsertDiscoveredSession. The successor is a live agent,
    //    not a bare shell, before it can commit.
    // Seam B Guard-F1: an ORGANIC seat has no node provenance — the inherited rig
    // attachment still carries to the successor (continuity of the same seat).
    const successorPosture = this.rigRepo.getNodePolicyProvenance(node.id)?.launchPosture
      ?? this.rigRepo.getRigPolicyProvenance(statusResult.status.rig_id)?.launchPosture
      ?? "floor"; // R2 terminal: absence = the locked floor on the continuity edge too
    // The successor must carry its own generation from its first byte. This reservation writes no
    // ledger row; commit consumes it, while every failed pre-commit branch remains unregistered.
    const occupantGeneration = this.sessionRegistry.reserveOccupantGeneration();
    const launch = await this.successorLauncher.createSuccessor({
      // Seam B: the successor is the SAME seat continuing — persisted policy posture carries.
      // 0.5.2-07 model fidelity: carry the seat's SPEC-pinned model so the successor launch reads the
      // spec (else the running topology drifts from the founder-designed one at every handover).
      // A4-profile: likewise carry the codex config profile (adapter emits -p) — the restore path
      // already threads it; handover must too, or a profile-pinned codex seat reverts at handover.
      node: { id: node.id, runtime: node.runtime, cwd: node.cwd, launchPosture: successorPosture, model: node.model, codexConfigProfile: node.codex_config_profile ?? undefined },
      departingSessionName: latestSession.session_name,
      occupantGeneration,
      // OPR.0.5.5.5: a fork-sourced successor launches as a NATIVE FORK of the
      // resolved id — it carries the incumbent context from its first byte.
      ...(forkSource ? { forkSource } : {}),
      ...(predecessorGeneration
        ? { onReplacementStarted: () => { this.appliedLaunchObservations.invalidateGeneration(predecessorGeneration); } }
        : {}),
    });
    if (!launch.ok) {
      return {
        ok: false,
        code: "successor_create_failed",
        message: `Handover failed at step "${launch.step}": ${launch.message}`,
        // The registry binding is unchanged (commit never ran). A resolve_pane failure leaves the live
        // retiree wholly untouched; a failure after the in-place respawn leaves the seat re-wakeable from
        // its provider session file (never destroyed). Inspect tmux/daemon logs and retry.
        guidance: "The seat's registry binding is unchanged. If the failure was after the in-place respawn, the seat is re-wakeable from its provider session file. Inspect tmux/daemon logs and retry.",
      };
    }

    // 3. fresh: deliver the captured restore packet to the live successor BEFORE
    //    continuity verify (a blank occupant is a relaunch, not a handover).
    //    discovered is operator-prepared and needs no delivery.
    let contextDelivered = false;
    // OPR.0.5.3.5 mini-req 7 — the authored recap pointer leg, resolved through the injected
    // reader; every outcome labeled (present with chain depth / named absence / omitted when
    // the resolver itself is absent).
    let authoredRecapInfo: { authoredRecap?: { address: string; chainLength: number }; authoredRecapAbsentReason?: string } | null = null;
    if (this.authoredRecapResolver) {
      const authored = this.authoredRecapResolver(input.seatRef);
      authoredRecapInfo = "address" in authored
        ? { authoredRecap: authored }
        : { authoredRecapAbsentReason: authored.absentReason };
    }
    if (parsed.source.mode === "fresh") {
      // B16 — the recap was resolved at step 1b (pre-launch); an unavailable verdict rides the
      // packet as a NAMED line, never a silent omission.
      const resolved = "recap" in predecessorRecapResolution ? predecessorRecapResolution : null;
      const delivered = await this.deliverRestorePacket(launch.tmuxSession, {
        seatRef: input.seatRef,
        reason,
        departingSession: latestSession.session_name,
        capturedContext,
        recap: resolved?.recap,
        recordPath: resolved?.recordPath,
        recapUnavailableReason: resolved ? undefined : (predecessorRecapResolution as { unavailableReason: string }).unavailableReason,
        ...(authoredRecapInfo ?? {}),
      });
      if (!delivered.ok) {
        // Partial: the successor is live in the preserved pane but the context packet never landed —
        // unwind the discovery candidate (cleanup marks it vanished; it NEVER kills the preserved seat)
        // and leave the binding unchanged (no false-green). The seat is re-wakeable from its session file.
        await this.successorLauncher.cleanup(launch.tmuxSession, launch.discoveredId);
        return {
          ok: false,
          code: "context_delivery_failed",
          message: `Handover failed at step "deliver-restore-packet": ${delivered.message}`,
          guidance: "The successor candidate was unwound and the seat's binding is unchanged; the seat is re-wakeable from its provider session file. Retry after tmux delivery is healthy.",
        };
      }
      contextDelivered = true;
    }

    // OPR.0.5.5.5 — per-source execution outcome, recorded on the result so the
    // operator sees exactly what carried context (fork origin / primed set).
    let sourceOutcome: SeatHandoverMutationResult["sourceOutcome"];
    if (parsed.source.mode === "fork" && forkSource) {
      sourceOutcome = { mode: "fork", forkedFrom: parsed.source.ref ?? latestSession.session_name };
    }
    if (parsed.source.mode === "rebuild") {
      // rebuild: the successor is a FRESH conversation primed from the seat's
      // durable chain — the live incumbent's context is deliberately not
      // trusted. The executed set, its gaps, and an empty chain are all named.
      const chain = this.rebuildPrimingResolver
        ? this.rebuildPrimingResolver(input.seatRef)
        : { emptyReason: "no rebuild priming resolver wired on this daemon" };
      let primedArtifacts: Array<{ address: string; label: string }> = [];
      let gaps: string[] = [];
      let emptyChainReason: string | undefined;
      if ("artifacts" in chain && chain.artifacts.length > 0) {
        const resolved = resolveRebuildArtifacts(
          { mode: "rebuild", ref: { kind: "artifact_set", value: chain.artifacts.map((artifact) => artifact.address) } },
          { exists: this.rebuildArtifactExists },
        );
        gaps = resolved.gaps;
        if (resolved.ok) {
          const present = new Set(resolved.files.map((file) => file.absolutePath));
          primedArtifacts = chain.artifacts.filter((artifact) => present.has(artifact.address));
        } else {
          emptyChainReason = resolved.error;
        }
      } else {
        emptyChainReason = "artifacts" in chain ? "the durable chain resolved to zero artifacts" : chain.emptyReason;
      }
      sourceOutcome = { mode: "rebuild", primedArtifacts, gaps, ...(emptyChainReason ? { emptyChainReason } : {}) };
      const delivered = await this.deliverRebuildPrimingPacket(launch.tmuxSession, {
        seatRef: input.seatRef,
        reason,
        departingSession: latestSession.session_name,
        primedArtifacts,
        gaps,
        emptyChainReason,
      });
      if (!delivered.ok) {
        // Same partial-state contract as the fresh packet: unwind the candidate,
        // binding unchanged, seat re-wakeable — never a false complete.
        await this.successorLauncher.cleanup(launch.tmuxSession, launch.discoveredId);
        return {
          ok: false,
          code: "context_delivery_failed",
          message: `Handover failed at step "deliver-rebuild-priming": ${delivered.message}`,
          guidance: "The successor candidate was unwound and the seat's binding is unchanged; the seat is re-wakeable from its provider session file. Retry after tmux delivery is healthy.",
        };
      }
      contextDelivered = true;
    }

    // 4. Verify continuity + rebind via the EXISTING discovered->commit path.
    //    On any failure, unwind the created successor (no binding to unwind).
    return this.finalizeWithDiscovered({
      seatRef: input.seatRef,
      status: statusResult.status,
      node,
      latestSession,
      discoveredRef: launch.discoveredId,
      reportedSource: parsed.source,
      reason,
      operator,
      contextDelivered,
      // B2 (launched/fresh): the launch-scraped resume token captured by the
      // successor launcher is persisted atomically at commit (provenance scrape).
      launchToken: launch.resumeToken ? { token: launch.resumeToken, resumeType: launch.resumeType } : null,
      occupantGeneration,
      appliedLaunch: launch.appliedLaunch ?? null,
      sourceOutcome,
      cleanup: () => this.successorLauncher.cleanup(launch.tmuxSession, launch.discoveredId),
    });
  }

  /**
   * The shared discovered->commit path (validation + presence-verify + rebind).
   * `cleanup` is invoked before returning ANY failure so a composer-created
   * successor is unwound; the discovered-source caller passes null (nothing to
   * unwind). The `hasSession` probe here is the continuity/presence verify that
   * runs BEFORE the commit releases the original binding.
   */
  private async finalizeWithDiscovered(input: {
    seatRef: string;
    status: SeatStatus;
    node: NodeRow;
    latestSession: SessionRow;
    discoveredRef: string;
    reportedSource: SeatHandoverSource;
    reason: string;
    operator: string | null;
    contextDelivered: boolean;
    /** Launch-scraped resume token for a fresh successor (persisted at commit). */
    launchToken: { token: string; resumeType?: string } | null;
    /** Source-bound generation reserved before a fresh successor started; null for discovered seats. */
    occupantGeneration: string | null;
    /** Exact enforcing value returned by the launch adapter; absent for adopted/discovered successors. */
    appliedLaunch: AppliedLaunchObservation | null;
    /** OPR.0.5.5.5 — per-source execution outcome, threaded onto the result. */
    sourceOutcome?: SeatHandoverMutationResult["sourceOutcome"];
    cleanup: (() => Promise<void>) | null;
  }): Promise<SeatHandoverResult> {
    const fail = async (result: SeatHandoverResult): Promise<SeatHandoverResult> => {
      if (input.cleanup) await input.cleanup();
      return result;
    };

    const discovered = this.discoveryRepo.getDiscoveredSession(input.discoveredRef);
    if (!discovered) {
      return fail({
        ok: false,
        code: "discovered_not_found",
        message: `Discovery record "${input.discoveredRef}" not found.`,
        guidance: "Run discovery and list active discovered sessions before retrying.",
      });
    }
    if (discovered.status !== "active") {
      return fail({
        ok: false,
        code: "discovered_not_active",
        message: `Discovery record "${discovered.id}" is ${discovered.status}, not active.`,
        guidance: "Use an active, unclaimed discovered successor session.",
      });
    }
    // A COMPOSER-LAUNCHED successor (fresh/fork/rebuild — OPR.0.5.5.5 executes all
    // three through the same cutover) INTENTIONALLY reuses the departing session's
    // canonical name — it respawns into the retiree's pane in place, preserving the
    // seat name (that is the whole point). Only a DISCOVERED-source successor must
    // be a DISTINCT session; handing a seat to its own current session is a no-op
    // there, so the guard applies to discovered only.
    if (input.reportedSource.mode === "discovered" && discovered.tmuxSession === input.latestSession.session_name) {
      return fail({
        ok: false,
        code: "successor_is_current",
        message: "Discovered successor is already the current occupant for this seat.",
        guidance: "Use a distinct successor session.",
      });
    }

    const runtimeMismatch = this.checkRuntimeMismatch(input.node.runtime, discovered.runtimeHint);
    if (runtimeMismatch) return fail(runtimeMismatch);

    const managedOwner = this.lookupManagedOwner(discovered.tmuxSession, input.node.id);
    if (managedOwner) {
      return fail({
        ok: false,
        code: "successor_already_managed",
        message: `Successor tmux session "${discovered.tmuxSession}" is already managed by ${managedOwner.logical_id}@${managedOwner.rig_name}.`,
        guidance: "Use an unclaimed discovered successor session.",
      });
    }

    let tmuxPresent: boolean;
    try {
      tmuxPresent = await this.tmuxAdapter.hasSession(discovered.tmuxSession);
    } catch (err) {
      return fail({
        ok: false,
        code: "tmux_probe_failed",
        message: `Could not verify successor tmux session "${discovered.tmuxSession}": ${err instanceof Error ? err.message : String(err)}`,
        guidance: "Retry after tmux health is known; probe failures are not treated as absence.",
      });
    }
    if (!tmuxPresent) {
      return fail({
        ok: false,
        code: "successor_tmux_absent",
        message: `Successor tmux session "${discovered.tmuxSession}" is not present.`,
        guidance: "Run discovery again or provide a live discovered successor session.",
      });
    }

    const committed = this.commit({
      seatRef: input.seatRef,
      status: input.status,
      node: input.node,
      latestSession: input.latestSession,
      reportedSource: input.reportedSource,
      reason: input.reason,
      operator: input.operator,
      discovered,
      contextDelivered: input.contextDelivered,
      launchToken: input.launchToken,
      occupantGeneration: input.occupantGeneration,
      appliedLaunch: input.appliedLaunch,
      sourceOutcome: input.sourceOutcome,
    });
    if (!committed.ok) return fail(committed);

    // B2 (discovered): the successor is an operator-prepared live session we did
    // NOT launch, so no launch token was scraped. Best-effort capture its live
    // resume token AT COMMIT — reusing the FR-3 pure derive-helper — so a crash
    // right after handover can still resume (the window FR-3 closes elsewhere).
    // Post-commit + non-blocking (mirrors FR-3): the async derivation cannot run
    // inside better-sqlite3's synchronous transaction. Never logs the token.
    if (input.reportedSource.mode === "discovered" && "result" in committed) {
      await this.captureDiscoveredResumeToken({
        rigId: input.status.rig_id,
        nodeId: input.node.id,
        sessionId: committed.result.newSessionId,
        sessionName: discovered.tmuxSession,
        runtime: input.node.runtime,
      });
    }
    return committed;
  }

  /**
   * B2 — best-effort discovered-mode resume-token capture at commit. Derives the
   * live token via the shared FR-3 derive-helper (pure read), persists it with
   * provenance "adoption" (the rank guard governs clobber), and emits the same
   * captured/preserved/skipped events FR-3 uses. Honest failure = persist
   * nothing + a redacted skip event. NEVER throws, never logs the token.
   */
  private async captureDiscoveredResumeToken(input: {
    rigId: string; nodeId: string; sessionId: string; sessionName: string; runtime: string | null;
  }): Promise<void> {
    try {
      const derived = await deriveResumeToken(
        { runtime: input.runtime, sessionName: input.sessionName },
        this.captureDeps,
      );
      if (derived.outcome === "exempt" || derived.outcome === "noop") return;
      const runtime = input.runtime as string; // non-null past exempt
      if (derived.outcome === "skipped") {
        this.emitCaptureSkip(input, runtime, derived.reason);
        return;
      }
      const wrote = this.sessionRegistry.updateResumeToken(input.sessionId, derived.resumeType, derived.token, "adoption");
      try {
        this.eventBus.emit(wrote
          ? {
              type: "session.resume_token_captured",
              rigId: input.rigId, nodeId: input.nodeId, sessionName: input.sessionName, sessionId: input.sessionId,
              runtime, outcome: "captured", resumeType: derived.resumeType, provenance: "adoption", redacted: true,
            }
          : {
              type: "session.resume_token_captured",
              rigId: input.rigId, nodeId: input.nodeId, sessionName: input.sessionName, sessionId: input.sessionId,
              runtime, outcome: "preserved", resumeType: derived.resumeType, reason: "higher_rank_present", redacted: true,
            });
      } catch { /* best-effort */ }
    } catch {
      // best-effort — capture never fails or blocks the handover
    }
  }

  private emitCaptureSkip(
    input: { rigId: string; nodeId: string; sessionId: string; sessionName: string },
    runtime: string,
    reason: "missing_sidecar" | "parse_error" | "probe_timeout" | "invalid_token",
  ): void {
    try {
      this.eventBus.emit({
        type: "session.resume_token_captured",
        rigId: input.rigId, nodeId: input.nodeId, sessionName: input.sessionName, sessionId: input.sessionId,
        runtime, outcome: "skipped", reason, redacted: true,
      });
    } catch { /* best-effort */ }
  }

  /** Best-effort capture of the departing seat's visible terminal before the
   *  successor is created. Never throws; an empty capture is honestly recorded
   *  as "no capture available" in the restore packet. */
  private async captureDepartingContext(departingSession: string): Promise<string> {
    try {
      const screen = await this.tmuxAdapter.capturePaneScreen(departingSession);
      return screen ?? "";
    } catch {
      return "";
    }
  }

  /** OPR.0.5.5.5 — deliver the rebuild priming packet through the same shipped
   *  interactive-text transport as the restore packet. The packet points the
   *  successor at the durable artifacts (it reads them itself) and names every
   *  gap and an empty chain out loud — never a silent partial priming. */
  private async deliverRebuildPrimingPacket(
    successorSession: string,
    info: {
      seatRef: string;
      reason: string;
      departingSession: string;
      primedArtifacts: Array<{ address: string; label: string }>;
      gaps: string[];
      emptyChainReason?: string;
    },
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const lines = [
      `# Seat rebuild handover — ${info.seatRef}`,
      `You are a REBUILT successor for this seat (reason: ${info.reason}, at ${this.now().toISOString()}). Your predecessor session was ${info.departingSession}; its live context was deliberately NOT carried. Prime yourself from the durable artifacts below, highest trust first.`,
    ];
    if (info.primedArtifacts.length > 0) {
      lines.push("", "Priming artifacts (read each, in order):");
      for (const artifact of info.primedArtifacts) lines.push(`- ${artifact.address} — ${artifact.label}`);
    }
    if (info.gaps.length > 0) {
      lines.push("", "Declared but MISSING on disk (known gaps, named so nothing is silently dropped):");
      for (const gap of info.gaps) lines.push(`- ${gap}`);
    }
    if (info.emptyChainReason) {
      lines.push("", `The durable chain is EMPTY: ${info.emptyChainReason}. You start from seat identity alone — say so in your first status report.`);
    }
    const sent = await this.tmuxAdapter.sendText(successorSession, lines.join("\n"));
    if (!sent.ok) {
      return { ok: false, message: (sent as { message?: string }).message ?? "send_text failed" };
    }
    // Same spike-proven 200ms settle as the restore packet (staged-not-consumed class).
    await this.sleep(200);
    const submit = await this.tmuxAdapter.sendKeys(successorSession, ["C-m"]);
    if (!submit.ok) {
      return { ok: false, message: (submit as { message?: string }).message ?? "submit failed" };
    }
    return { ok: true };
  }

  /** Deliver the captured restore packet to a fresh successor via the shipped
   *  interactive-text transport (send_text + Enter), mirroring the startup
   *  orchestrator's initial-prompt delivery. */
  private async deliverRestorePacket(
    successorSession: string,
    info: {
      seatRef: string;
      reason: string;
      departingSession: string;
      capturedContext: string;
      /** The predecessor's bounded from-record recap + record path (omitted when unresolved). */
      recap?: JsonlExchange[];
      recordPath?: string;
      /** B16 — when the recap did not resolve, the NAMED reason (rendered, never silent). */
      recapUnavailableReason?: string;
      authoredRecap?: { address: string; chainLength: number };
      authoredRecapAbsentReason?: string;
    },
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const packet = buildRestorePacket({ ...info, handoverAt: this.now().toISOString() });
    const sent = await this.tmuxAdapter.sendText(successorSession, packet);
    if (!sent.ok) {
      return { ok: false, message: (sent as { message?: string }).message ?? "send_text failed" };
    }
    // B16 rework (r2 live door finding): the SHARED paste-then-submit sequencing — the transport's
    // spike-proven 200ms settle between send_text and C-m (session-transport.ts, "Wait 200ms").
    // Without it the multi-KB packet sat STAGED-UNSENT as collapsed paste blocks in the successor's
    // input box (r2 measured 46s until a manual Enter) — the handover committed complete while the
    // packet was never consumed: the staged-not-consumed class, shipped by the product itself.
    await this.sleep(200);
    const submit = await this.tmuxAdapter.sendKeys(successorSession, ["C-m"]);
    if (!submit.ok) {
      return { ok: false, message: (submit as { message?: string }).message ?? "submit failed" };
    }
    return { ok: true };
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
      "SELECT id, runtime, cwd, model, codex_config_profile FROM nodes WHERE rig_id = ? AND logical_id = ?"
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
    reportedSource: SeatHandoverSource;
    reason: string;
    operator: string | null;
    discovered: ReturnType<DiscoveryRepository["getDiscoveredSession"]> & NonNullable<unknown>;
    contextDelivered: boolean;
    launchToken: { token: string; resumeType?: string } | null;
    occupantGeneration: string | null;
    appliedLaunch: AppliedLaunchObservation | null;
      sourceOutcome?: SeatHandoverMutationResult["sourceOutcome"];
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
      // (e/Class-B): capture the RETIRING occupant's generation BEFORE registerClaimedSession mints the
      // successor's tenure below — after that mint the node's "current" generation IS the successor's
      // (the name is reused), so this is the only point the retiree's generation is resolvable.
      const retiringGeneration =
        this.sessionRegistry.currentOccupantGenerationForSession(input.latestSession.session_name) ?? undefined;
      // atom-B: a seat handover mints a HANDOVER-kind occupant generation (not the default 'adopt').
      const newSession = this.sessionRegistry.registerClaimedSession(
        input.node.id,
        input.discovered.tmuxSession,
        "handover",
        input.occupantGeneration,
      );
      // W3: registerClaimedSession mints the successor generation. Only now may
      // the exact adapter-returned launch effect be attached to that tenure.
      // The store is best-effort, so observation persistence can never make an
      // otherwise successful handover fail.
      if (input.appliedLaunch) {
        const successorGeneration = this.sessionRegistry.currentOccupantTenure(input.node.id)?.generationUuid;
        if (successorGeneration) {
          this.appliedLaunchObservations.recordGeneration(successorGeneration, input.appliedLaunch);
        }
      }
      // B2 (launched/fresh): persist the launch-scraped resume token atomically
      // with the claim, provenance "scrape" (mirrors StartupOrchestrator's
      // launch-token capture). Validity-guarded; a malformed token is dropped,
      // never a bad write. The token is never logged.
      if (input.launchToken) {
        const validated = validateResumeToken(input.node.runtime, input.launchToken.token);
        if (validated.ok) {
          this.sessionRegistry.updateResumeToken(newSession.id, validated.resumeType, validated.token, "scrape");
        }
      }
      this.discoveryRepo.markClaimed(input.discovered.id, input.node.id);
      // KI-14: the continuity label must describe THIS launch. A NULL here let node-inventory derive
      // the seat's continuity from restore_outcome — a stamp from a restore days earlier — so the
      // 2026-08-22 wave's seats reported fresh/fresh-primed while their panes ran resumed contexts.
      // fresh mode is now verified-blank at launch (successor_pane_not_blank guards it), so 'fresh'
      // is earned; a discovered successor's continuity is genuinely unknown and stays NULL.
      // OPR.0.5.5.5 — the executed source records its own continuity vocabulary
      // (the startup-orchestrator set): fresh->fresh, fork->forked,
      // rebuild->rebuilt; discovered stays null (continuity unknown to us).
      const continuityOutcome = input.reportedSource.mode === "fresh" ? "fresh"
        : input.reportedSource.mode === "fork" ? "forked"
        : input.reportedSource.mode === "rebuild" ? "rebuilt"
        : null;
      this.db.prepare(`
        UPDATE nodes SET
          occupant_lifecycle = 'active',
          continuity_outcome = ?,
          handover_result = 'complete',
          previous_occupant = ?,
          handover_at = ?
        WHERE id = ?
      `).run(continuityOutcome, input.latestSession.session_name, handoverAt, input.node.id);

      // Ghost-stage (e) re-key seam — the rebind is done; now invalidate the RETIRING occupant's
      // seat-name-keyed stores so the successor never inherits a ghost (drained compaction stage, frozen
      // telemetry sample, delayed lifecycle message to the retired generation). The ghost-stage slice
      // owns the per-store impls behind OccupantInvalidator; this seat owns this single call. Under the
      // cutover the successor reuses the seat name, so retiring === successor here — Class-A is safe by
      // TIMING (runs before the successor writes) and Class-B is gen-scoped via retiringGeneration (the
      // retiree's generation, captured above pre-mint). Optional dep: absent → skipped, never blocks.
      this.occupantInvalidator?.invalidateRetiringOccupant({
        retiringSessionName: input.latestSession.session_name,
        successorSessionName: input.discovered.tmuxSession,
        retiringGeneration,
      });

      const event = this.eventBus.persistWithinTransaction({
        type: "seat.handover_completed",
        rigId: input.status.rig_id,
        nodeId: input.node.id,
        logicalId: input.status.logical_id,
        previousOccupant: input.latestSession.session_name,
        currentOccupant: input.discovered.tmuxSession,
        source: input.reportedSource.raw,
        reason: input.reason,
        operator: input.operator,
      });
      return { newSessionId: newSession.id, previousSessionIdsSuperseded, event };
    });

    let committed: { newSessionId: string; previousSessionIdsSuperseded: string[]; event: PersistedEvent };
    try {
      committed = tx();
      // S19 ruling 01530 — the SOLE narrow call: after the commit lands, the activity
      // oracle sees the swap as its own event, keyed by the durable node id, identified
      // by the successor tenure (never the retiree's). In-memory, post-commit, optional.
      this.activityOracle?.declareOccupantSwap(input.node.id, committed.newSessionId);
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
        source: input.reportedSource,
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
        ...(input.sourceOutcome ? { sourceOutcome: input.sourceOutcome } : {}),
        sideEffects: {
          departingSessionKilled: false,
          startupContextDelivered: input.contextDelivered,
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

/** Assemble the restore packet delivered to a fresh successor: seat identity + handover reason +
 *  predecessor session + the captured predecessor terminal, and a bounded LABELED-FROM-RECORD recap
 *  of the last few predecessor exchanges + a receipt line naming the predecessor record path
 *  (honest-degraded). The recap is the permanent claude-runtime leg of scrollback preservation —
 *  claude-code seats run in the tmux alternate screen, which keeps no scrollback buffer, so no
 *  successor pane can natively scroll into the predecessor conversation there; the cutover's
 *  respawn-pane owns native scrollback on codex seats. Never called "scrollback": the label must
 *  make replay unmistakable, because passing a replayed recap off as native history is the one
 *  thing the requirement cannot survive. Exported for unit test. */
export function buildRestorePacket(info: {
  seatRef: string;
  reason: string;
  departingSession: string;
  handoverAt: string;
  capturedContext: string;
  /** The last few predecessor exchanges read from the provider JSONL, bounded on count and per-exchange length. */
  recap?: Array<{ role: string; content: string }>;
  /** The predecessor provider record path (claude transcript_path / codex rollout_path). */
  recordPath?: string | null;
  /** B16 — the NAMED reason when no recap resolved; rendered as its own labeled line so the absence
   *  is visible in the pane (honest-degraded means labeled, not silent). */
  recapUnavailableReason?: string;
  /** OPR.0.5.3.5 mini-req 7 — the AUTHORED seat recap (decisions-with-rationale, written by the
   *  outgoing occupant): rendered as a POINTER to its address (no-copy composition — the packet
   *  never inlines the bytes; the successor pulls by address). */
  authoredRecap?: { address: string; chainLength: number };
  /** Labeled absence for the authored leg (B16 doctrine — never a silent omission). */
  authoredRecapAbsentReason?: string;
}): string {
  const captured = info.capturedContext.trim();
  const lines = [
    "=== OpenRig seat handover — restore context ===",
    `Seat: ${info.seatRef}`,
    `Reason: ${info.reason}`,
    `Predecessor session: ${info.departingSession}`,
    `Handover at: ${info.handoverAt}`,
    "",
    "--- Predecessor terminal (captured) ---",
    captured.length > 0 ? captured : "(no capture available)",
  ];
  // The from-record recap + receipt, ONLY when a record is actually available (no fabrication).
  // B16 — an absent recap is no longer a silent omission: the packet names the reason, so a
  // successor (and the operator reading the pane) can tell "nothing resolved because X" from
  // "the feature never ran".
  if (info.recap && info.recap.length > 0 && info.recordPath) {
    lines.push(
      "",
      "--- Predecessor recap (replayed from record, not the live terminal) ---",
      ...info.recap.map((e) => `${e.role}: ${e.content}`),
      "",
      `Predecessor record: ${info.recordPath}`,
      "  (honest-degraded: durable, true, and grep-able — not human-scrollable; the recap above is replayed from it)",
    );
  } else if (info.recapUnavailableReason) {
    lines.push(
      "",
      `--- Predecessor recap unavailable: ${info.recapUnavailableReason} ---`,
    );
  }
  // The AUTHORED recap leg (mini-req 7): a pointer, never inlined bytes — the
  // successor pulls by address so there is exactly one copy to trust.
  if (info.authoredRecap) {
    const chainNote = info.authoredRecap.chainLength > 0
      ? ` (${info.authoredRecap.chainLength} superseded predecessor${info.authoredRecap.chainLength === 1 ? "" : "s"} retained on the seat tree)`
      : "";
    lines.push(
      "",
      `--- Authored seat recap: ${info.authoredRecap.address}${chainNote} ---`,
      "Composed into handover/post-compaction profiles automatically (rig context profile <pack> --situation handover --rig <rig> --seat <seat>); or read it directly at the seat tree address above.",
    );
  } else if (info.authoredRecapAbsentReason) {
    lines.push(
      "",
      `--- Authored seat recap: ${info.authoredRecapAbsentReason} ---`,
    );
  }
  return lines.join("\n");
}
