import { nonInterruptiveNotice } from "../adapters/non-interruptive.js";
import { planModelAliasNotice } from "../adapters/yolo-mode.js";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { isClaudeResumeType } from "../adapters/claude-resume.js";
import type { StartupAction, StartupProofSelection, StartupFailureStage } from "./types.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  ProjectionResult, StartupDeliveryResult, ForkSource, ReadinessResult,
} from "./runtime-adapter.js";
import { isAttentionRequiredReadinessCode, resolveConcreteHint } from "./runtime-adapter.js";
import type { ProjectionPlan } from "./projection-planner.js";
import { issueStartupChallenge, STARTUP_PROOF_INSTRUCTION_LINE } from "./startup-proof.js";
import { resolveStartupProof } from "./startup-resolver.js";
import { AppliedLaunchObservationStore } from "./applied-launch-observation-store.js";
import { NativePermissionStore } from "./native-permission-store.js";
import { RigRepository } from "./rig-repository.js";
import { SessionTransport, inspectStartupStagedText } from "./session-transport.js";
import { settleOwnStartupPaste, startupSubmissionEvidence, STARTUP_SUBMIT_CAPTURE_LINES, STARTUP_SUBMIT_RETRIES, waitForClaudeInputBox, type StartupSubmissionDiagnostic } from "./startup-submission-evidence.js";
import type { AppliedLaunchObservation } from "./permission-drift.js";
import { resolveReadinessTimeoutMs } from "./readiness-timeout.js";
import { SettingsStore } from "./user-settings/settings-store.js";
import { shellQuote } from "../adapters/shell-quote.js";
import { observeClaudeResumeLaunch, type ClaudeLaunchedProcess, type NativeProcessLister } from "./native-process-lineage.js";
import { CommunityHarnessRuntimeAdapter } from "../adapters/community-harness-runtime-adapter.js";
import { join } from "node:path";
import { guidanceFileIsLink, readFootprintAnswer, readGuidanceFile, routerLineSkipReason, type FootprintAnswer, type RouterLineWriteResult } from "./footprint-choice.js";
import { SEAT_SKILLS_BOOTSTRAP_BLOCK_ID, describeSkillRouterFootprint, seatSkillsLineEdited, refusedSeatSkillsRootForNode, seatCatalogKeptNote, seatRouterKeptNote, seatSkillPathsForNode, seatSkillPluginDirForNode, writeSeatSkillCatalog, writeSeatSkillRouter } from "./seat-skill-storage.js";
import { recordConversationPromptForNode, recordForkConversationPromptForNode, seatLaunchAdditionsForLaunch, systemPromptPendingNoteForNode } from "./seat-launch-additions.js";

// Why a startup prompt's submission could not be confirmed, as told to the operator when the
// proof line is held back.
const UNCONFIRMED_STAGED = "the prompt still looked staged in the input box";
const UNCONFIRMED_UNOBSERVABLE = "the input box could not be observed";
const UNCONFIRMED_UNCLEAR = "the input box did not clearly show the prompt as submitted";
const UNCONFIRMED_RETRY_REFUSED = "the guarded Enter retry did not go through";

/**
 * The proof line is held back on purpose when the startup prompt isn't confirmed submitted. Say that
 * only this one line was skipped, so it doesn't read as the agent or the rig failing to start.
 */
export function startupProofHeldBackWarning(reason: string | undefined): string {
  return "Startup proof instruction held back: only the extra line asking the agent to run its startup check "
    + "was not sent, so nothing is typed over input that may still be in the box. The startup prompt itself was "
    + `sent, but its submission could not be confirmed: ${reason ?? "it was not observed submitted"}.`;
}

type PendingForkContext = { parentToken: string; isRestore: boolean };
export type PendingStartupContext = { eventSeq: number } & (
  | { mode: "fresh" }
  | ({ mode: "fork" } & PendingForkContext)
);

/** Pending context belongs to this occupant and is consumed before delivery starts. */
export function readPendingStartupContext(db: Database.Database, nodeId: string, sessionId: string): PendingStartupContext | null {
  const row = db.prepare("SELECT seq, payload FROM events WHERE node_id = ? AND type IN ('node.startup_pending', 'node.startup_ready', 'node.startup_failed') ORDER BY seq DESC LIMIT 1").get(nodeId) as { seq: number; payload: string } | undefined;
  if (!row) return null;
  const event = JSON.parse(row.payload);
  if (event.type !== "node.startup_failed" || event.sessionId !== sessionId) return null;
  if (event.freshContextPending === true) return { eventSeq: row.seq, mode: "fresh" };
  const fork = event.forkContextPending;
  if (typeof fork?.parentToken === "string" && fork.parentToken.trim() && typeof fork.isRestore === "boolean") {
    return { eventSeq: row.seq, mode: "fork", parentToken: fork.parentToken, isRestore: fork.isRestore };
  }
  return null;
}

export function hasClaudeResumeIdentityWork(
  sessionRegistry: SessionRegistry,
  sessionId: string,
  runtime: string | undefined,
  resumeToken: string | undefined | null,
  resumeType: string | undefined | null,
  skipHarnessLaunch?: boolean,
  continuityOutcome?: string,
): boolean {
  if (skipHarnessLaunch || runtime !== "claude-code" || !resumeToken) {
    return false;
  }
  if (continuityOutcome !== undefined && continuityOutcome !== "resumed") {
    return false;
  }
  if (resumeType !== undefined && resumeType !== null && !isClaudeResumeType(resumeType)) {
    return true;
  }
  const matches = sessionRegistry.resumeTokenMatches(sessionId, "claude_id", resumeToken.trim())
    || sessionRegistry.claudeResumeRotatedFrom(sessionId, resumeToken);
  return !matches;
}

export function hasPendingStartupWork(db: Database.Database, nodeId: string, sessionId: string): boolean {
  const row = db.prepare(
    "SELECT payload FROM events WHERE node_id = ? AND type IN ('node.startup_pending', 'node.startup_ready', 'node.startup_failed') ORDER BY seq DESC LIMIT 1",
  ).get(nodeId) as { payload: string } | undefined;
  if (!row) return true;
  try {
    const event = JSON.parse(row.payload);
    if (event.type !== "node.startup_failed") return true;
    if (event.sessionId !== sessionId) return true;
    if (event.freshContextPending === true || event.forkContextPending) return true;
    if (event.hasPendingWork !== false) return true;
    return false;
  } catch {
    return true;
  }
}

export function getLatestStartupFailedEvent(db: Database.Database, nodeId: string, sessionId: string): {
  type: string;
  sessionId?: string;
  freshContextPending?: boolean;
  forkContextPending?: { parentToken: string; isRestore: boolean };
  hasPendingWork?: boolean;
  stage?: StartupFailureStage;
  requestedResumeToken?: string | null;
  requestedResumeType?: string | null;
} | null {
  const row = db.prepare(
    "SELECT payload FROM events WHERE node_id = ? AND type IN ('node.startup_pending', 'node.startup_ready', 'node.startup_failed') ORDER BY seq DESC LIMIT 1",
  ).get(nodeId) as { payload: string } | undefined;
  if (!row) return null;
  try {
    const event = JSON.parse(row.payload);
    if (event.type !== "node.startup_failed") return null;
    if (!event.sessionId || event.sessionId !== sessionId) return null;
    return event;
  } catch {
    return null;
  }
}

export function isRecoverableStartupFailure(db: Database.Database, nodeId: string, sessionId: string): boolean {
  if (readPendingStartupContext(db, nodeId, sessionId)) return false;
  if (hasPendingStartupWork(db, nodeId, sessionId)) return false;

  const sess = db.prepare("SELECT resume_type, resume_token FROM sessions WHERE id = ?").get(sessionId) as { resume_type?: string | null; resume_token?: string | null } | undefined;
  if (sess?.resume_token && sess.resume_type !== null && sess.resume_type !== undefined && !isClaudeResumeType(sess.resume_type)) {
    const node = db.prepare("SELECT runtime FROM nodes WHERE id = ?").get(nodeId) as { runtime?: string } | undefined;
    if (node?.runtime === "claude-code") return false;
  }

  const event = getLatestStartupFailedEvent(db, nodeId, sessionId);
  if (!event) return false;
  if (event.freshContextPending === true || event.forkContextPending) return false;
  if (event.hasPendingWork !== false) return false;
  if (event.stage !== "post_delivery_readiness" && event.stage !== "readiness_check") return false;
  return true;
}

// -- Types --

/** The seat-skills bootstrap line among a seat's startup files: the built-in guidance merged into its managed block
 *  (never the Codex catalog, which shares the logical name but is sent as text). */
export function isSeatSkillsBootstrapLine(file: Pick<ResolvedStartupFile, "path" | "deliveryHint">): boolean {
  return file.path === SEAT_SKILLS_BOOTSTRAP_BLOCK_ID && file.deliveryHint === "guidance_merge";
}

export interface StartupInput {
  /** Internal attempt state: a launch input may already have reached the harness, so it cannot be replayed. */
  firstInputPassed?: boolean;
  rigId: string;
  nodeId: string;
  sessionId: string;
  binding: NodeBinding;
  adapter: RuntimeAdapter;
  plan: ProjectionPlan;
  resolvedStartupFiles: ResolvedStartupFile[];
  startupActions: StartupAction[];
  isRestore: boolean;
  /**
   * OPR.0.7.0.13: a fresh relaunch's decisions about the seat's own skills (seatSkillReplay): saved skill entries and
   * startup skill files that this start must not project or install again. They stay in the saved startup context.
   */
  replaySkip?: { entryIds: ReadonlySet<string>; files: ReadonlySet<string> };
  /** Session name for harness launch (used as --name flag). */
  sessionName?: string;
  /** Resume token for restore path. Mutually exclusive with forkSource. */
  resumeToken?: string;
  /** Runtime-native type for resumeToken (for example claude_id or codex_id). */
  resumeType?: string;
  /**
   * Fork-source for new-seat-from-prior-conversation path. Mutually
   * exclusive with resumeToken. v1: kind="native_id" only. The captured
   * post-fork token (returned by the adapter) is what gets persisted on
   * the new seat — the parent token is NEVER persisted.
   */
  forkSource?: ForkSource;
  /**
   * Rebuild-mode artifact set (operator-declared via
   * `session_source.mode: rebuild`). When set, the orchestrator merges
   * these artifacts into the post-launch delivery path, fresh-launches
   * the harness with NO `resumeToken` and NO `forkSource`, and records
   * `continuityOutcome: "rebuilt"` on the seat. NEVER paired with
   * `resumeToken` or `forkSource` — rebuild is a distinct creation path.
   */
  rebuildArtifacts?: ResolvedStartupFile[];
  /** Skip harness launch (legacy nodes that already resumed via old helpers). */
  skipHarnessLaunch?: boolean;
  /** Allow runtime adapter retry_fresh fallback when native resume data is stale. */
  allowFreshFallback?: boolean;
  /** Exact resume preserves saved context; its empty Claude plan must not disable activity hooks. */
  preserveStartupContext?: boolean;
  /** Continue the same fresh occupant after a prerequisite, without another harness launch. */
  continueFreshStartup?: boolean;
  /** Deliberate fresh replacement retains the seat’s durable destination obligations. */
  includeDurableObligations?: boolean;
  /** Readiness timeout in ms (defaults to runtime.readiness_timeout_seconds). */
  readinessTimeoutMs?: number;
}

type StartupSendFailure = { error: string };

type StartupDeliveryInput = StartupInput & {
  submissionWarnings: string[]; stagedSubmissionWarning?: string;
  warnings: string[];
  startupAttemptId: string; sendOrder: number; submissionDiagnostics: StartupSubmissionDiagnostic[];
  /** Claude only: whether the latest interactive send was observed submitted (a clear composer). */
  lastSubmissionConfirmed?: boolean;
  /** Claude only: why the latest interactive send was not confirmed, in words for the operator. */
  lastSubmissionUnconfirmedReason?: string;
  /** Claude only: the runtime refused an earlier startup turn (an expired login, say), so later inputs are held. */
  refusedTurn?: ReadinessResult;
  /** A later input was pasted before the refusal appeared; its submission is uncertain, so never replay it. */
  refusedWithStagedInput?: boolean;
  /** How many startup inputs were held after that refusal, and so are still owed. */
  heldInputs?: number;
  /** A one-shot (non-idempotent) startup action was typed, so the startup must not be delivered again as a whole. */
  oneShotSent?: boolean;
};

export type StartupResult = { warnings?: string[] } & (
  | { ok: true; startupStatus: "ready"; continuityOutcome: "resumed" | "fresh" | "forked" | "rebuilt"; submission?: { status: "unverified" | "staged"; reasons: string[]; warning?: string; diagnostics?: StartupSubmissionDiagnostic[] };
    /** OPR.0.7.0.13 (router): what happened to the one-line bootstrap at this start, when the seat has one. */
    routerLine?: RouterLineWriteResult;
    /** Codex (#1524): the native process the managed resume was proven on, carried to restore's join. */
    resumedProcess?: { pid: number; startedAt: string } }
  // `evidence` carries the last-N pane lines for `attention_required`
  // outcomes so restore-orchestrator's per-node mapping can populate
  // `attentionEvidence` on the RestoreNodeResult. Internal type only;
  // not persisted on the failure event.
  | { ok: false; startupStatus: "attention_required" | "failed"; errors: string[]; evidence?: string; recovery?: string; missingConversation?: true;
    probe?: import("./native-resume-probe-evidence.js").NativeResumeProbeEvidence });

interface StartupOrchestratorDeps {
  db: Database.Database;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  tmuxAdapter: TmuxAdapter;
  /** Read file content for concrete-hint resolution. */
  readFile?: (path: string) => string;
  /** Sleep between paste and submit for tmux-driven TUIs. */
  sleep?: (ms: number) => Promise<void>;
  readinessSettings?: Pick<SettingsStore, "resolveOne">;
  /** Process observation for a Claude resume launch's own record of its process (#1077). */
  listProcesses?: NativeProcessLister;
}

/**
 * Drives one node from projected resources to startup_status: ready.
 *
 * Sequence (NS-T05):
 * 1. Mark pending, emit node.startup_pending
 * 2. Project resources (filesystem)
 * 3. Deliver pre-launch files (guidance_merge, skill_install → filesystem)
 * 4. Launch harness via adapter.launchHarness()
 * 5. Wait for harness ready (retry with exponential backoff, configurable timeout)
 * 6. For fresh sessions, inject the built-in identity anchor as the first prompt
 *    and deliver remaining post-launch files (send_text → TUI)
 * 7. Execute after_files actions
 * 8. Execute after_ready actions
 * 9. Persist startup context + resume token
 * 10. Mark ready, emit node.startup_ready
 *
 * Failure leaves startup_status: failed, node visible.
 * The caller creates session + binding first via NodeLauncher,
 * then calls startNode() with the full startup payload.
 */
export class StartupOrchestrator {
  readonly db: Database.Database;
  private sessionRegistry: SessionRegistry;
  private eventBus: EventBus;
  private tmuxAdapter: TmuxAdapter;
  private sleep: (ms: number) => Promise<void>;
  private appliedLaunchStore: AppliedLaunchObservationStore;
  private sessionTransport: SessionTransport;
  private readinessSettings: Pick<SettingsStore, "resolveOne">;
  private listProcesses: NativeProcessLister | undefined;

  constructor(deps: StartupOrchestratorDeps) {
    if (deps.db !== deps.sessionRegistry.db) throw new Error("StartupOrchestrator: sessionRegistry must share the same db handle");
    if (deps.db !== deps.eventBus.db) throw new Error("StartupOrchestrator: eventBus must share the same db handle");
    this.db = deps.db;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.readFile = deps.readFile ?? (() => "");
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.readinessSettings = deps.readinessSettings ?? new SettingsStore();
    this.listProcesses = deps.listProcesses;
    this.appliedLaunchStore = new AppliedLaunchObservationStore(deps.db);
    this.sessionTransport = new SessionTransport({
      db: deps.db,
      rigRepo: new RigRepository(deps.db),
      sessionRegistry: deps.sessionRegistry,
      tmuxAdapter: deps.tmuxAdapter,
      eventBus: deps.eventBus,
    });
  }

  private readFile: (path: string) => string;

  /** The process this Claude resume launch started, as the launch itself observes it (#1077): the one
   *  the adapter's readiness check pinned first, else one observed now. A rotation its hook later
   *  reports counts only for this process; unobserved, none counts. */
  private async recordClaudeResumeLaunch(sessionId: string, target: string | null | undefined, token: string,
    pinned: ClaudeLaunchedProcess | undefined): Promise<void> {
    try {
      if (pinned) {
        this.sessionRegistry.recordResumeLaunchProcess(sessionId, token, pinned);
        return;
      }
      if (!target) return;
      const launched = await observeClaudeResumeLaunch({ target, tmux: this.tmuxAdapter, listProcesses: this.listProcesses, token });
      if (launched) this.sessionRegistry.recordResumeLaunchProcess(sessionId, token, launched);
    } catch { /* best-effort: without it a rotation stays unproved, as before */ }
  }

  async startNode(input: StartupInput): Promise<StartupResult> {
    const warnings: string[] = [];
    const result = await this.startNodeWithWarnings(input, warnings);
    return { ...result, ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}) };
  }

  private async startNodeWithWarnings(input: StartupInput, warnings: string[]): Promise<StartupResult> {
    const guard = this.tmuxAdapter.deliveryGuard;
    if (guard && !guard.ownsLifecycle(input.nodeId)) {
      return guard.lifecycle([input.nodeId], () => this.startNodeWithWarnings(input, warnings));
    }
    try {
      input = { ...input, binding: new NativePermissionStore(this.db).apply(input.binding, input.adapter.runtime) };
    } catch (error) {
      return this.fail(input, "failed", [`Permission selection: ${(error as Error).message}`], undefined, false, undefined, false, "permission_selection", true);
    }
    // #25: launch, restore replay, relaunch, continue and added members deliver
    // guidance through here, so the rig's managed-block destination is bound once
    // for the adapter. Handover does not come here: the successor launches directly
    // and reads the file already written in its cwd.
    const rigRepo = new RigRepository(this.db);
    input = { ...input, binding: { ...input.binding, nonInterruptive: rigRepo.getRigNonInterruptive(input.rigId) } };
    const claudeManagedBlockFile = rigRepo.getRigClaudeManagedBlockFile(input.rigId);
    if (claudeManagedBlockFile) input = { ...input, binding: { ...input.binding, claudeManagedBlockFile } };
    // OPR.0.7.0.13: a Claude seat whose plugin OpenRig keeps (already on its CLAUDE_CODE_PLUGIN_DIRS) gets every skill
    // there, profile resources and startup skill files too. A seat without one keeps the project, as before, so a
    // skill never lands where nothing points.
    if (input.adapter.runtime === "claude-code" && !input.binding.seatSkillsRoot) {
      const seatPlugin = seatSkillPluginDirForNode(this.db, input.nodeId);
      if (seatPlugin) input = { ...input, binding: { ...input.binding, seatSkillsRoot: join(seatPlugin, "skills") } };
    }
    // OPR.0.7.0.13 (Codex C2): a Codex seat with its own storage gets its skills there, and its catalog, rebuilt after
    // this launch's projection, is what its per-seat startup text delivers.
    const codexSeatSkills = input.adapter.runtime === "codex" ? seatSkillPathsForNode(this.db, input.nodeId) : undefined;
    if (codexSeatSkills && !input.binding.seatSkillsRoot) input = { ...input, binding: { ...input.binding, seatSkillsRoot: codexSeatSkills.skillsRoot } };
    // A seat whose storage a link refused keeps its skills' target there, where each is refused and named; they never
    // fall back into the project.
    if (!input.binding.seatSkillsRoot && (input.adapter.runtime === "claude-code" || input.adapter.runtime === "codex")) {
      const refused = refusedSeatSkillsRootForNode(this.db, input.nodeId);
      if (refused) input = { ...input, binding: { ...input.binding, seatSkillsRoot: refused.skillsRoot, seatSkillsRefused: refused.reason } };
    }
    // OPR.0.7.0.9: a Claude seat's own launch additions, the copies present in its seat storage; a missing copy is named.
    if (input.adapter.runtime === "claude-code" && !input.binding.launchAdditions) {
      const { additions, missing, refused } = seatLaunchAdditionsForLaunch(this.db, input.nodeId);
      if (additions) input = { ...input, binding: { ...input.binding, launchAdditions: additions } };
      for (const file of missing) warnings.push(`${input.sessionName ?? input.nodeId}: seat_launch_addition_missing: ${file} is not in this seat's storage; launched without it`);
      for (const reason of refused) warnings.push(`${input.sessionName ?? input.nodeId}: seat_launch_addition_refused: ${reason}; launched without it`);
    }
    const deliveryInput: StartupDeliveryInput = { ...input, warnings, submissionWarnings: [], startupAttemptId: randomUUID(), sendOrder: 0, submissionDiagnostics: [] };
    const startupAssisted = input.adapter instanceof CommunityHarnessRuntimeAdapter && input.adapter.startupAssisted();
    const errors: string[] = [];
    let continuityOutcome: "resumed" | "fresh" | "forked" | "rebuilt" = input.resumeToken
      ? "resumed"
      : input.forkSource
        ? "forked"
        : input.rebuildArtifacts && input.rebuildArtifacts.length > 0
          ? "rebuilt"
          : "fresh";
    let appliedLaunch: AppliedLaunchObservation | undefined;
    let resumedProcess: { pid: number; startedAt: string } | undefined;
    const forkContext: PendingForkContext | undefined = input.adapter.runtime === "codex"
      && input.forkSource?.kind === "native_id" && input.forkSource.value?.trim()
      ? { parentToken: input.forkSource.value.trim(), isRestore: input.isRestore } : undefined;
    const launchGeneration = this.sessionRegistry.currentOccupantTenure(input.nodeId)?.generationUuid;

    // 1. Mark pending
    this.sessionRegistry.updateStartupStatus(input.sessionId, "pending");
    const context = input.isRestore ? "restore" : "fresh_start";
    let startupProof: StartupProofSelection;
    try {
      startupProof = resolveStartupProof(input.startupActions, context);
    } catch (err) {
      return this.fail(input, "failed", [`Startup proof selection: ${(err as Error).message}`], undefined, false, undefined, false, "proof_selection", true);
    }
    this.eventBus.emit({ type: "node.startup_pending", rigId: input.rigId, nodeId: input.nodeId, startupProof });

    // 2. Project resources. A contained Claude resume has an intentionally empty
    // replay plan, not a newly selected profile with activity hooks removed.
    // RestoreOrchestrator already reconciled the saved activity selection before
    // native resume. Fresh launches still project empty plans to support removal.
    let projectionResult: ProjectionResult;
    if (!(input.preserveStartupContext && input.adapter.runtime === "claude-code" && input.plan.entries.length === 0)) try {
      const skip = input.replaySkip;
      const projectedPlan = skip && skip.entryIds.size > 0
        ? { ...input.plan, entries: input.plan.entries.filter((e) => !(e.category === "skill" && skip.entryIds.has(e.effectiveId))) }
        : input.plan;
      projectionResult = await input.adapter.project(projectedPlan, input.binding);
      warnings.push(...(projectionResult.warnings ?? []));
      if (projectionResult.failed.length > 0) {
        for (const f of projectionResult.failed) {
          errors.push(`Projection failed for ${f.effectiveId}: ${f.error}`);
        }
        return this.fail(input, "failed", errors, undefined, false, undefined, false, "projection", true);
      }
    } catch (err) {
      errors.push(`Projection error: ${(err as Error).message}`);
      return this.fail(input, "failed", errors, undefined, false, undefined, false, "projection", true);
    }

    // 3. Partition startup files by concrete hint: pre-launch (filesystem) vs post-launch (TUI)
    // Note: new file-building paths (NS-T05+) emit only concrete hints. The auto fallback
    // is compatibility-only for pre-NS-T05 persisted startup contexts in node_startup_context.
    //
    // Rebuild-mode artifacts (when set) are merged in front of resolvedStartupFiles
    // so the operator's trust-precedence ordering is preserved when the post-launch
    // delivery loop walks the array. Rebuild artifacts are tagged
    // appliesOn: ["fresh_start"] by the resolver, which matches the rebuild context.
    const sourceFiles = input.rebuildArtifacts && input.rebuildArtifacts.length > 0
      ? [...input.rebuildArtifacts, ...input.resolvedStartupFiles]
      : input.resolvedStartupFiles;
    // OPR.0.7.0.13 (router, R1.1): the one-line bootstrap is delivered on its own (below), only with a yes, and never
    // stops the launch. Every start reads the answer, so a saved context from before the line was opt-in (or from while
    // it was on) delivers it only while the yes stands. Nothing already written is removed.
    const bootstrapLine = sourceFiles.filter((f) => f.appliesOn.includes(context) && !input.replaySkip?.files.has(f.absolutePath)
      && isSeatSkillsBootstrapLine(f));
    const applicableFiles = sourceFiles.filter((f) => f.appliesOn.includes(context) && !input.replaySkip?.files.has(f.absolutePath)
      && !isSeatSkillsBootstrapLine(f));
    const preLaunchFiles: ResolvedStartupFile[] = [];
    let postLaunchFiles: ResolvedStartupFile[] = [];
    for (const f of applicableFiles) {
      const hint = f.deliveryHint === "auto"
        ? resolveConcreteHint(f.path, this.safeReadFile(f.absolutePath), f.orientation)
        : f.deliveryHint;
      if (hint === "send_text") {
        postLaunchFiles.push(f);
      } else {
        preLaunchFiles.push(f);
      }
    }

    // 4. Deliver pre-launch files (filesystem: guidance_merge, skill_install)
    // Always call even with empty list so adapters can provision runtime-specific config (e.g. context collectors)
    try {
      const deliveryResult = await input.adapter.deliverStartup(preLaunchFiles, input.binding);
      warnings.push(...(deliveryResult.warnings ?? []));
      if (deliveryResult.failed.length > 0) {
        for (const f of deliveryResult.failed) {
          errors.push(`Pre-launch file delivery failed: ${f.path}: ${f.error}`);
        }
        return this.fail(input, "failed", errors, undefined, false, undefined, false, "pre_launch_files", true);
      }
    } catch (err) {
      errors.push(`Pre-launch delivery error: ${(err as Error).message}`);
      return this.fail(input, "failed", errors, undefined, false, undefined, false, "pre_launch_files", true);
    }

    // OPR.0.7.0.13 (router, R1.1): the bootstrap line, on its own: with a yes it is delivered into the seat's guidance file;
    // otherwise it is skipped with the answer's reason. A line that can't be written is this start's named result (from
    // the delivery's own error), never a failed launch.
    let routerLine: RouterLineWriteResult | undefined;
    if (bootstrapLine.length > 0) {
      let answer: FootprintAnswer | null = null;
      try { answer = readFootprintAnswer(this.readinessSettings); } catch { /* unreadable: reported as such */ }
      const target = describeSkillRouterFootprint([{ seat: input.sessionName ?? input.nodeId, runtime: input.adapter.runtime,
        cwd: input.binding.cwd ?? ".", claudeManagedBlockFile: input.binding.claudeManagedBlockFile ?? null }]).files[0]?.path;
      if (target) {
        const skip = routerLineSkipReason(answer);
        if (skip) routerLine = { answer, files: [{ path: target, outcome: "skipped", reason: skip }] };
        else if (guidanceFileIsLink(target)) {
          // A linked guidance file is someone's layout, often a file outside the project: the line isn't written through it.
          routerLine = { answer, files: [{ path: target, outcome: "linked" }] };
          warnings.push(`seat_skills_line_linked: ${target} is a link, so the line wasn't written through it; the seat started without it`);
        } else if (seatSkillsLineEdited(readGuidanceFile(target))) {
          // Someone edited the line: a start leaves their block as it is, as rig down does.
          routerLine = { answer, files: [{ path: target, outcome: "edited" }] };
          warnings.push(`seat_skills_line_edited: ${target} holds an edited seat-skills line, so this start left it as it is`);
        } else {
          try {
            // The saved line is optional, and the adapters swallow an optional file's write error; for this one isolated
            // call, mark it required so the adapter reports the real error, which is handled here without failing the start.
            const delivered = await input.adapter.deliverStartup(bootstrapLine.map((f) => ({ ...f, required: true })), input.binding);
            const failed = delivered.failed.find((f) => f.path === bootstrapLine[0]!.path) ?? delivered.failed[0];
            routerLine = { answer, files: [failed ? { path: target, outcome: "unwritable", error: failed.error } : { path: target, outcome: "delivered" }] };
          } catch (err) {
            routerLine = { answer, files: [{ path: target, outcome: "unwritable", error: (err as Error).message }] };
          }
          const unwritable = routerLine.files.find((f) => f.outcome === "unwritable");
          if (unwritable && unwritable.outcome === "unwritable") warnings.push(`seat_skills_line_unwritable: ${unwritable.path}: ${unwritable.error}; the seat started without it`);
        }
      }
    }

    // OPR.0.7.0.13 (router): the seat's one generated router skill, after every pre-launch skill writer, so it lists
    // every skill the seat starts with. A router that can't be written is this seat's named result; the launch goes on.
    const routerSeatSkills = input.adapter.runtime === "claude-code" ? seatSkillPathsForNode(this.db, input.nodeId) : codexSeatSkills;
    if (routerSeatSkills) {
      try {
        const router = writeSeatSkillRouter(routerSeatSkills);
        if (router.kept) warnings.push(seatRouterKeptNote(router));
      } catch (err) { warnings.push(`seat_router_not_written: ${(err as Error).message}`); }
    }

    // OPR.0.7.0.13 (Codex C2): the seat's catalog, built after every pre-launch skill writer (projection and startup
    // skill files) and before the post-launch text that sends it, so it lists every skill the seat starts with.
    if (codexSeatSkills) {
      try {
        const catalog = writeSeatSkillCatalog(codexSeatSkills);
        if (catalog.kept) warnings.push(`${seatCatalogKeptNote(catalog)}${catalog.reason === "edited" ? ", and that file is what the seat's startup text sends" : ""}`);
      } catch (err) { warnings.push(`seat skill catalog not written: ${(err as Error).message}`); }
    }

    // 7. Persist startup context for restore replay
    if (!input.preserveStartupContext) try {
      this.db.prepare(
        "INSERT OR REPLACE INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)"
      ).run(
        input.nodeId,
        JSON.stringify(input.plan.entries.map((e) => ({ category: e.category, effectiveId: e.effectiveId, sourceSpec: e.sourceSpec, sourcePath: e.sourcePath, resourcePath: e.resourcePath, absolutePath: e.absolutePath, resourceType: e.resourceType, mergeStrategy: e.mergeStrategy, target: e.target }))),
        JSON.stringify(input.resolvedStartupFiles),
        JSON.stringify(input.startupActions),
        input.adapter.runtime,
      );
    } catch (error) {
      return this.fail(input, "failed", [`Startup context persistence failed: ${String(error)}`], undefined, false, undefined, false, "persistence", true);
    }

    const identityAction = this.extractSessionIdentityAction(input.startupActions, context);
    let launchPrompt: { prompt: string; remainingFiles: ResolvedStartupFile[] } | undefined;
    let launchChallenge: ReturnType<typeof issueStartupChallenge> | null = null;

    // 5. Launch harness (unless skipped for legacy nodes)
    // A community harness's seat: record the selection on this session before the app starts. It's provenance for
    // later reads (identity, activity, labels, restore), not launch success or identity proof.
    if (input.adapter instanceof CommunityHarnessRuntimeAdapter) {
      try { this.sessionRegistry.recordCommunityHarnessSelection(input.sessionId, input.adapter.runtime); }
      catch (err) { errors.push(`Couldn't record the community harness selection: ${(err as Error).message}`); return this.fail(input, "failed", errors); }
    }

    if (!input.skipHarnessLaunch) {
      try {
        let launchResumeToken = input.resumeToken;
        let attemptedFreshFallback = false;

        while (true) {
          if (input.adapter.runtime === "claude-code") {
            // Before the launch: Claude's SessionStart hook can land before launchHarness returns.
            try {
              this.sessionRegistry.recordResumeLaunch(input.sessionId, launchResumeToken ?? null);
            } catch { /* best-effort: without it a rotation stays unproved, as before */ }
          }
          if (input.adapter instanceof CommunityHarnessRuntimeAdapter && input.adapter.firstInput()
            && !launchResumeToken && continuityOutcome === "fresh" && identityAction) {
            launchChallenge = startupProof.mode === "authenticated" ? issueStartupChallenge(this.eventBus, {
              rigId: input.rigId, nodeId: input.nodeId, contractSource: JSON.stringify(input.resolvedStartupFiles),
            }) : null;
            launchPrompt = this.composeInitialSessionPrompt(deliveryInput, identityAction, postLaunchFiles,
              launchChallenge?.promptBlock ?? null, input.includeDurableObligations);
          }
          const launchResult = await input.adapter.launchHarness(input.binding, {
            name: input.sessionName ?? input.binding.tmuxSession ?? "",
            ...(launchPrompt ? { firstInputText: launchPrompt.prompt } : {}),
            resumeToken: launchResumeToken,
            ...(launchResumeToken && input.resumeType ? { resumeType: input.resumeType } : {}),
            ...(input.forkSource && !launchResumeToken ? { forkSource: input.forkSource } : {}),
          });
          if (launchResult.firstInput) {
            input.firstInputPassed = deliveryInput.firstInputPassed = true;
            this.eventBus.emit({ type: "node.startup_first_input_passed", rigId: input.rigId, nodeId: input.nodeId,
              sessionId: input.sessionId, ...launchResult.firstInput });
            warnings.push("First startup input passed at launch; submission is not confirmed.");
          }
          if (launchResult.ok) {
            appliedLaunch = launchResult.appliedLaunch;
            resumedProcess = launchResult.resumedProcess;
            if (input.adapter.runtime === "claude-code" && launchResumeToken?.trim()) {
              await this.recordClaudeResumeLaunch(input.sessionId, input.binding.tmuxPane ?? input.binding.tmuxSession, launchResumeToken.trim(), launchResult.launchedProcess);
            }
            const notice = nonInterruptiveNotice(input.adapter.runtime, input.binding);
            if (notice) warnings.push(`${input.sessionName ?? input.nodeId}: ${notice}`);
            const planNote = planModelAliasNotice(input.adapter.runtime, input.binding, input.sessionName ?? input.nodeId);
            if (planNote) warnings.push(`${input.sessionName ?? input.nodeId}: ${planNote}`);
            for (const note of launchResult.warnings ?? []) warnings.push(`${input.sessionName ?? input.nodeId}: ${note}`);
            const normalizedResumeToken = launchResult.resumeToken?.trim();
            if (normalizedResumeToken) {
              try {
                if (launchResult.resumeProvenance) {
                  this.sessionRegistry.recordLauncherReportedToken(input.sessionId, launchResult.resumeType ?? "", normalizedResumeToken, launchResult.resumeProvenance);
                } else {
                  this.sessionRegistry.updateResumeToken(input.sessionId, launchResult.resumeType ?? "", normalizedResumeToken, "scrape");
                }
              } catch { /* best-effort */ }
            }
            // OPR.0.7.0.9: the prompt a new conversation starts with; on a resume, a changed prompt is pending.
            if (input.adapter.runtime === "claude-code" && input.binding.launchAdditions?.appendSystemPromptFile) {
              const resumed = launchResumeToken?.trim();
              if (resumed) {
                const pending = systemPromptPendingNoteForNode(this.db, input.nodeId, resumed);
                if (pending) warnings.push(`${input.sessionName ?? input.nodeId}: ${pending}`);
              } else if (normalizedResumeToken) {
                // A fork starts from its parent's conversation: it takes the parent's recorded start (or none).
                try {
                  if (input.forkSource?.value) recordForkConversationPromptForNode(this.db, input.nodeId, normalizedResumeToken, input.forkSource.value);
                  else recordConversationPromptForNode(this.db, input.nodeId, normalizedResumeToken);
                } catch { /* best-effort */ }
              }
            }
            break;
          }

          const shouldRetryFresh =
            !!launchResumeToken && !input.firstInputPassed
            && input.allowFreshFallback !== false
            && launchResult.recovery === "retry_fresh"
            && !attemptedFreshFallback;

          if (shouldRetryFresh) {
            launchResumeToken = undefined;
            continuityOutcome = "fresh";
            attemptedFreshFallback = true;
            continue;
          }

          // Pod-aware Codex auth-refusal (probe → verifyResumeLaunch →
          // recovery: "attention_required"). Surface as attention_required
          // startup_status with evidence so restore-orchestrator's per-node
          // mapping at lines 867-877 can return RestoreNodeResult with
          // status: "attention_required" + attentionEvidence (mirroring the
          // legacy mapping at :725-735).
          if (launchResult.recovery === "attention_required") {
            // Preserve the attempted lineage for later no-input reconciliation,
            // but do not certify it: attention also covers runner exits/timeouts.
            // retry_fresh already cleared launchResumeToken; ordinary failures
            // skip this branch.
            const normalizedResumeToken = launchResumeToken?.trim();
            const normalizedResumeType = input.resumeType?.trim();
            if (normalizedResumeToken && normalizedResumeType) {
              try {
                this.sessionRegistry.recordResumeAttempt(
                  input.sessionId,
                  normalizedResumeType,
                  normalizedResumeToken,
                );
              } catch { /* best-effort */ }
            }
            // The launch is retained for reconciliation; record its process as it does when ready.
            if (input.adapter.runtime === "claude-code" && normalizedResumeToken) {
              await this.recordClaudeResumeLaunch(input.sessionId, input.binding.tmuxPane ?? input.binding.tmuxSession, normalizedResumeToken, launchResult.launchedProcess);
            }
            errors.push(`Harness launch requires attention: ${launchResult.error}`);
            // isRestore selects context, not native continuity: pod-aware exact
            // resume also uses false. Only an actual fresh launch may re-prime; an
            // unverified fork keeps its unsent context for a verified continuation.
            return this.fail(input, "attention_required", errors, launchResult.evidence,
              launchResult.forkIdentityPending ? forkContext ?? false : continuityOutcome === "fresh",
              undefined, false, "harness_launch", true, launchResult.probe);
          }

          errors.push(`Harness launch failed: ${launchResult.error}`);
          return this.fail(input, "failed", errors, undefined, false, launchResult.recovery, launchResult.missingConversation === true, "harness_launch", true, launchResult.probe);
        }
      } catch (err) {
        errors.push(`Harness launch error: ${(err as Error).message}`);
        return this.fail(input, "failed", errors, undefined, false, undefined, false, "harness_launch", true);
      }
    }

    // A successful new lean launch replaces the occupant's proof boundary even
    // if readiness later fails. Failed launches and resume/adopt retain history.
    const isFreshLaunch = continuityOutcome === "fresh" && (!input.skipHarnessLaunch || input.continueFreshStartup === true);
    // Once a startup turn was refused, the result says what's owed, whatever error comes later. Continuing replays the
    // whole fresh startup, so don't offer it for a restore, a possibly delivered one-shot, or an uncertain staged input.
    const owed = (also: string[] = [], refused = deliveryInput.refusedTurn) => refused
      ? this.owedStartup(deliveryInput, refused, continuityOutcome, isFreshLaunch && !input.isRestore && !deliveryInput.oneShotSent && !deliveryInput.refusedWithStagedInput, also) : null;
    const shouldChallenge = isFreshLaunch
      && input.adapter.runtime !== "terminal" && startupProof.mode === "authenticated";
    if (isFreshLaunch && !shouldChallenge) {
      this.eventBus.emit({
        type: "node.startup_proof_skipped", rigId: input.rigId, nodeId: input.nodeId,
        reason: input.adapter.runtime === "terminal" ? "terminal" : "not_selected",
      });
    }

    // 6. Wait for harness readiness within the configured launch window.
    const getPendingReadinessWork = () => {
      const hasRemainingIdentityWork = hasClaudeResumeIdentityWork(
        this.sessionRegistry,
        input.sessionId,
        input.adapter.runtime,
        input.resumeToken,
        input.resumeType,
        input.skipHarnessLaunch,
        continuityOutcome,
      );
      return postLaunchFiles.length > 0 || (input.startupActions ?? []).some(
        (a) => a.phase === "after_files" || a.phase === "after_ready" || isSessionIdentityAction(a) || a.type === "send_text",
      ) || hasRemainingIdentityWork;
    };
    try {
      const readinessTimeoutMs = resolveReadinessTimeoutMs(input.readinessTimeoutMs, this.readinessSettings);
      const readiness = await this.waitForReady(input.adapter, input.binding, readinessTimeoutMs);
      if (!readiness.ready) {
        const hasPendingReadinessWork = getPendingReadinessWork();
        if (isAttentionRequiredReadinessCode(readiness.code)) {
          errors.push(`Startup requires attention: ${readiness.reason ?? "unknown"}`);
          return this.fail(input, "attention_required", errors, undefined, isFreshLaunch || (forkContext ?? false), undefined, false, "readiness_check", hasPendingReadinessWork);
        }
        errors.push(`Readiness timeout after ${readinessTimeoutMs / 1000}s — harness did not become interactive: ${readiness.reason ?? "unknown"}`);
        return this.fail(input, forkContext ? "attention_required" : "failed", errors, undefined, forkContext ?? false, undefined, false, "readiness_check", hasPendingReadinessWork);
      }
    } catch (err) {
      errors.push(`Readiness check error: ${(err as Error).message}`);
      return this.fail(input, "failed", errors, undefined, false, undefined, false, "readiness_check", getPendingReadinessWork());
    }

    if (input.skipHarnessLaunch && forkContext) {
      // Continuing a fork is a read-only identity check, never another fork or
      // a resume of its parent. Do this after readiness, before any prompt.
      let identity: { resumeToken: string; resumeType: string } | null | undefined;
      let captureError: string | undefined;
      try {
        identity = await input.adapter.captureForkIdentity?.(input.binding, forkContext.parentToken);
      } catch (error) { captureError = String(error); }
      // Check even a missing/failed observation before publishing a failure.
      const current = this.db.prepare("SELECT id FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(input.nodeId) as { id: string } | undefined;
      const binding = this.sessionRegistry.getBindingForNode(input.nodeId);
      if (current?.id !== input.sessionId) {
        // The newer occupant owns the node's startup event stream. Update only
        // the previous session: a late event here could hide the new pending context.
        this.sessionRegistry.updateStartupStatus(input.sessionId, "attention_required");
        return { ok: false, startupStatus: "attention_required", errors: ["The occupant changed during fork verification; no startup context was sent."] };
      }
      if (binding?.tmuxPane !== input.binding.tmuxPane || binding?.tmuxSession !== input.binding.tmuxSession) {
        return this.fail(input, "attention_required", ["The terminal binding changed during fork verification; no startup context was sent."]);
      }
      if (captureError !== undefined) {
        return this.fail(input, "attention_required", [`Fork identity verification failed: ${captureError}; no startup context was sent.`], undefined, forkContext);
      }
      if (!identity?.resumeToken || identity.resumeToken === forkContext.parentToken || identity.resumeType !== "codex_id") {
        return this.fail(input, "attention_required", ["The fork's child identity is not verified yet; no startup context was sent."], undefined, forkContext);
      }
      try {
        this.sessionRegistry.updateResumeToken(input.sessionId, identity.resumeType, identity.resumeToken, "scrape");
        if (!this.sessionRegistry.resumeTokenMatches(input.sessionId, identity.resumeType, identity.resumeToken)) {
          return this.fail(input, "attention_required", ["The verified fork child conflicts with protected session metadata; no startup context was sent."], undefined, forkContext);
        }
      } catch (error) {
        return this.fail(input, "attention_required", [`Fork identity verification failed: ${String(error)}; no startup context was sent.`], undefined, forkContext);
      }
    }

    // The adapter returned the exact enforcing value it inserted, and readiness
    // proved this managed launch became live. Persistence is deliberately
    // best-effort: observation failure yields UNKNOWN, never a failed launch.
    if (appliedLaunch && launchGeneration) {
      this.appliedLaunchStore.recordGeneration(launchGeneration, appliedLaunch);
    }

    // Normally issue proof after readiness; an opted-in launcher already received its challenge in the first input.
    // Ground truth is persisted before either delivery path.
    const challenge = launchChallenge ?? (shouldChallenge
      ? issueStartupChallenge(this.eventBus, {
          rigId: input.rigId,
          nodeId: input.nodeId,
          contractSource: JSON.stringify(input.resolvedStartupFiles),
        })
      : null);

    // A selected proof still works without a session_identity action: deliver
    // its standalone prompt after the post-launch contract files below.
    const consumedActions = new Set<StartupAction>();
    let challengeOnlyPrompt: string | null = null;
    if (continuityOutcome === "fresh" && identityAction) {
      const initialPrompt = input.firstInputPassed && launchPrompt
        ? { ok: true as const, remainingFiles: launchPrompt.remainingFiles }
        : await this.deliverInitialSessionPrompt(deliveryInput, identityAction, postLaunchFiles, challenge?.promptBlock ?? null, input.includeDurableObligations);
      if (!initialPrompt.ok) {
        errors.push(initialPrompt.error);
        return this.fail(input, "failed", errors, undefined, false, undefined, false, "initial_prompt", true);
      }
      postLaunchFiles = initialPrompt.remainingFiles;
      if (challenge) await this.sendProofInstruction(deliveryInput);
    } else if (challenge) {
      challengeOnlyPrompt = challenge.promptBlock;
    }

    // OPR.0.4.7.17 restore-order-correction (qitem-e99624f7). On a resumed
    // restore the work-triggering guidance/role.md is delivered as a post-launch
    // send_text file (step 7 below) and starts the seat's first turn at once. An
    // after_ready send_text "BEFORE you do anything else, load skills" preload
    // delivered later (step 9) therefore lands AFTER work has begun — the locked
    // action-before-work contract fails. Fix CAUSALLY, not by widening the send
    // delay: on restore, bundle the applicable after_ready send_text preload
    // action(s) IN FRONT of the first send_text post-launch file and deliver them
    // as the single leading turn — the restore analogue of the fresh
    // deliverInitialSessionPrompt identity+role.md bundle. Sequencing (not
    // timing) guarantees the preload precedes the role-triggered work turn; the
    // bundled actions are marked consumed so step 9 does not re-send them.
    if (continuityOutcome !== "fresh") {
      const preloadActions = input.startupActions.filter(
        (a) =>
          !isSessionIdentityAction(a) &&
          a.type === "send_text" &&
          a.phase === "after_ready" &&
          a.appliesOn.includes(context) &&
          !(input.isRestore && !a.idempotent),
      );
      if (preloadActions.length > 0) {
        const preload = await this.deliverRestorePreloadPrompt(deliveryInput, preloadActions, postLaunchFiles);
        if (!preload.ok) {
          errors.push(preload.error);
          return this.fail(input, "failed", errors, undefined, false, undefined, false, "restore_preload", true);
        }
        postLaunchFiles = preload.remainingFiles;
        for (const a of preloadActions) consumedActions.add(a);
      }
    }

    // 7. Deliver post-launch files (send_text → TUI, now that harness is ready)
    if (postLaunchFiles.length > 0) {
      try {
        // Keep reads/provisioning and required/optional errors in the adapter. Only Claude's
        // already-partitioned interactive files use the same bounded check as startup actions.
        const checkedSend = input.adapter.runtime === "claude-code" ? async (content: string) => {
          const failure = await this.sendInteractiveText(deliveryInput, content, "post_launch_file");
          if (failure) throw new Error(failure.error);
        } : undefined;
        const deliveryResult = await input.adapter.deliverStartup(postLaunchFiles, input.binding, checkedSend);
        warnings.push(...(deliveryResult.warnings ?? []));
        if (deliveryResult.failed.length > 0) {
          for (const f of deliveryResult.failed) {
            errors.push(`Post-launch file delivery failed: ${f.path}: ${f.error}`);
          }
          return owed(errors) ?? this.fail(deliveryInput, "failed", errors, undefined, false, undefined, false, "post_launch_files", true);
        }
      } catch (err) {
        errors.push(`Post-launch delivery error: ${(err as Error).message}`);
        return owed(errors) ?? this.fail(deliveryInput, "failed", errors, undefined, false, undefined, false, "post_launch_files", true);
      }
    }

    // Challenge-only delivery remains best-effort. Staging is reported without
    // turning a recoverable composer into a startup failure/occupant rollback.
    if (challengeOnlyPrompt && input.binding.tmuxSession) {
      const challengeFailure = await this.sendInteractiveText(deliveryInput, challengeOnlyPrompt, "challenge");
      if (!challengeFailure) await this.sendProofInstruction(deliveryInput);
    }

    // 8. Execute after_files actions
    const afterFilesResult = await this.executeActions(deliveryInput, "after_files");
    if (!afterFilesResult.ok) {
      return owed(afterFilesResult.errors) ?? this.fail(deliveryInput, "failed", afterFilesResult.errors, undefined, false, undefined, false, "after_files", true);
    }

    // 9. Execute after_ready actions (skipping any preload actions already
    // delivered ahead of role.md by the restore-order bundling above).
    const afterReadyResult = await this.executeActions(deliveryInput, "after_ready", consumedActions);
    if (!afterReadyResult.ok) {
      return owed(afterReadyResult.errors) ?? this.fail(deliveryInput, "failed", afterReadyResult.errors, undefined, false, undefined, false, "after_ready", true);
    }

    const held = owed();
    if (held) return held;

    // Delivering the first native prompt can reveal a provider refusal or
    // interactive gate. Bundled identity/preload prompts consume their files,
    // so the remaining file list alone does not tell us whether context was sent.
    if (postLaunchFiles.length > 0 || deliveryInput.sendOrder > 0) {
      try {
        const readiness = await input.adapter.checkReady(input.binding);
        if (!readiness.ready && isAttentionRequiredReadinessCode(readiness.code)) {
          // A fresh Claude start whose last startup turn was refused hasn't read what that turn sent: it's owed too.
          const refusedLast = input.adapter.runtime === "claude-code" && isFreshLaunch && deliveryInput.sendOrder > 0
            ? owed([], readiness) : null;
          if (refusedLast) return refusedLast;
          const hasRemainingIdentityWork = hasClaudeResumeIdentityWork(
            this.sessionRegistry,
            input.sessionId,
            input.adapter.runtime,
            input.resumeToken,
            input.resumeType,
            input.skipHarnessLaunch,
            continuityOutcome,
          );
          return this.fail(deliveryInput, "attention_required", [readiness.reason ?? "The native provider prerequisite failed after context delivery."], undefined, false, undefined, false, "post_delivery_readiness", hasRemainingIdentityWork);
        }
      } catch (error) {
        // An unavailable observation is not a positive provider prerequisite.
        this.recordSubmissionWarning(deliveryInput, `Post-delivery runtime state is unverified: ${(error as Error).message}`,
          `Post-delivery runtime state is unverified in ${input.binding.tmuxSession}: ${(error as Error).message}`);
      }
    }

    // Managed Claude resume needs agreement on the launched row, not a successful
    // scrape write: an equal hook/operator token may reject that lower-rank write.
    // Check after readiness/actions so a concurrent protected update is included.
    // Omitted type is inferred; claude_name may normalize to a proved claude_id.
    // An explicit type for another runtime is not that supported normalization.
    if (hasClaudeResumeIdentityWork(
      this.sessionRegistry,
      input.sessionId,
      input.adapter.runtime,
      input.resumeToken,
      input.resumeType,
      input.skipHarnessLaunch,
      continuityOutcome,
    )) {
      return this.fail(deliveryInput, "attention_required", [
        "Native resume was observed but its requested type or current session metadata conflicts or could not be retained; session preserved.",
      ], undefined, false, undefined, false, "identity_verification", false);
    }

    // Keep the running conversation, but don't call an explicitly assisted startup ready.
    // The paste and Enter were attempted; continuing startup must not paste that context a second time.
    if ((deliveryInput.sendOrder > 0 || input.firstInputPassed) && startupAssisted) {
      return this.fail(deliveryInput, "attention_required", [
        `Startup assisted for community harness "${input.adapter.runtime}" in ${input.binding.tmuxSession}: ${input.firstInputPassed ? "first input was passed at launch" : "text and Enter were sent"}, but submission isn't confirmed. `
          + `Check the pane and submit any staged startup text; don't resend it. Once the seat has responded, acknowledge it with `
          + `rig seat clear-attention ${shellQuote(input.binding.tmuxSession!)} --reason ${shellQuote("Startup submission checked; seat responded")}.`,
      ], undefined, false, undefined, false, "assisted_startup", false);
    }

    // 8. Mark ready
    this.sessionRegistry.updateStartupStatus(input.sessionId, "ready", new Date().toISOString());
    const submission = deliveryInput.submissionWarnings.length
      ? { status: deliveryInput.stagedSubmissionWarning ? "staged" as const : "unverified" as const,
          reasons: deliveryInput.submissionWarnings,
          ...(deliveryInput.submissionDiagnostics.length ? { diagnostics: deliveryInput.submissionDiagnostics } : {}),
          ...(deliveryInput.stagedSubmissionWarning ? { warning: deliveryInput.stagedSubmissionWarning } : {}) }
      : undefined;
    this.eventBus.emit({ type: "node.startup_ready", rigId: input.rigId, nodeId: input.nodeId, ...(submission ? { submission } : {}) });

    return { ok: true, startupStatus: "ready", continuityOutcome, ...(submission ? { submission } : {}), ...(routerLine ? { routerLine } : {}), ...(resumedProcess ? { resumedProcess } : {}) };
  }

  /** A failed attempt can continue only when it stopped before sending context, or when the runtime positively refused
   * the turn its context went to (an attention code after it) and no one-shot action was typed: a refused turn wasn't
   * read. Any newer pending/ready/failure event consumes that permission, including a
   * daemon loss during delivery: uncertain delivery is never blindly replayed.
   */
  canContinueStartup(nodeId: string, sessionId: string): boolean {
    return this.pendingStartupContext(nodeId, sessionId) !== null;
  }

  pendingStartupContext(nodeId: string, sessionId: string): PendingStartupContext | null {
    return readPendingStartupContext(this.db, nodeId, sessionId);
  }

  /**
   * Wait for harness readiness with exponential backoff.
   * Backoff: 1s → 2s → 4s → 8s → 16s (capped); the caller supplies the deadline.
   */
  private async waitForReady(
    adapter: RuntimeAdapter,
    binding: NodeBinding,
    timeoutMs: number = 30_000,
  ): Promise<import("./runtime-adapter.js").ReadinessResult> {
    const startTime = Date.now();
    let delay = 1000; // Start at 1s
    const maxDelay = 16_000;

    while (true) {
      const result = await adapter.checkReady(binding);
      if (result.ready) return result;
      if (isAttentionRequiredReadinessCode(result.code)) {
        return result;
      }

      const remaining = timeoutMs - (Date.now() - startTime);
      if (remaining <= 0) {
        return { ready: false, reason: result.reason ?? "readiness timeout" };
      }

      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
      delay = Math.min(delay * 2, maxDelay);
    }
  }

  private safeReadFile(path: string): string {
    try { return this.readFile(path); } catch { return ""; }
  }

  private fail(
    input: StartupInput & { submissionDiagnostics?: StartupSubmissionDiagnostic[] },
    status: "attention_required" | "failed",
    errors: string[],
    evidence?: string,
    pendingContext: boolean | PendingForkContext = false,
    recovery?: string,
    missingConversation = false,
    stage?: StartupFailureStage,
    hasPendingWork?: boolean,
    probe?: import("./native-resume-probe-evidence.js").NativeResumeProbeEvidence,
  ): StartupResult {
    if (input.firstInputPassed) {
      pendingContext = false;
      errors.push("First startup input was passed at launch; submission is unconfirmed. Inspect the pane before sending anything again.");
    }
    if (status === "attention_required" && typeof pendingContext === "object") {
      // The reasons above stay visible; this only says what the status means for the fork.
      errors.push("The fork's startup context is waiting to be sent: this attention status doesn't mean the forked conversation is healthy");
    }
    if (status === "attention_required" && pendingContext && input.binding.tmuxSession) {
      errors.push(`After resolving it in ${input.binding.tmuxSession}, run: rig seat continue ${shellQuote(input.binding.tmuxSession)}`);
    }
    this.sessionRegistry.updateStartupStatus(input.sessionId, status);
    this.eventBus.emit({
      type: "node.startup_failed",
      rigId: input.rigId,
      nodeId: input.nodeId,
      error: errors.join("; "),
      sessionId: input.sessionId,
      ...(pendingContext === true ? { freshContextPending: true }
        : pendingContext ? { forkContextPending: pendingContext } : {}),
      ...(input.submissionDiagnostics?.length ? { submissionDiagnostics: input.submissionDiagnostics } : {}),
      ...(stage ? { stage } : {}),
      ...(hasPendingWork !== undefined ? { hasPendingWork } : {}),
      requestedResumeToken: input.resumeToken ?? null,
      requestedResumeType: input.resumeType ?? null,
      ...(probe ? { probe } : {}),
    });
    return { ok: false, startupStatus: status, errors, evidence, ...(recovery ? { recovery } : {}),
      ...(probe ? { probe } : {}),
      ...(missingConversation ? { missingConversation: true as const } : {}) };
  }

  private async executeActions(
    input: StartupDeliveryInput,
    phase: "after_files" | "after_ready",
    skip?: Set<StartupAction>,
  ): Promise<{ ok: true } | { ok: false; errors: string[] }> {
    const errors: string[] = [];
    const context = input.isRestore ? "restore" : "fresh_start";

    for (const [actionIndex, action] of input.startupActions.entries()) {
      if (action.type === "startup_proof") continue; // declaration, never terminal input
      if (isSessionIdentityAction(action)) continue;
      if (skip?.has(action)) continue;

      // Phase filter
      if (action.phase !== phase) continue;

      // appliesOn filter
      if (!action.appliesOn.includes(context)) continue;

      // Non-idempotent actions skipped on restore (retry-as-restore safety)
      if (input.isRestore && !action.idempotent) continue;

      // Execute via tmux
      const heldBefore = input.heldInputs ?? 0;
      try {
        if (!input.binding.tmuxSession) {
          errors.push(`No tmux session for action: ${action.value}`);
          continue;
        }

        const sendError = await this.sendInteractiveText(input, action.value, phase, actionIndex);
        if (sendError) {
          errors.push(`Action failed (${action.type}): ${sendError.error}`);
        }
      } catch (err) {
        errors.push(`Action error (${action.type}): ${(err as Error).message}`);
      }
      // A one-shot that wasn't held may have reached the seat even when its send reported an error (the text typed, the
      // Enter failed): uncertain delivery is never replayed.
      if (!action.idempotent && (input.heldInputs ?? 0) === heldBefore) input.oneShotSent = true;
    }

    return errors.length > 0 ? { ok: false, errors } : { ok: true };
  }

  private extractSessionIdentityAction(
    actions: StartupAction[],
    context: "fresh_start" | "restore",
  ): StartupAction | null {
    return actions.find((action) => isSessionIdentityAction(action) && action.appliesOn.includes(context)) ?? null;
  }

  private composeInitialSessionPrompt(
    input: StartupDeliveryInput,
    identityAction: StartupAction,
    postLaunchFiles: ResolvedStartupFile[],
    challengeBlock: string | null,
    includeDurableObligations = false,
  ): { prompt: string; remainingFiles: ResolvedStartupFile[] } {
    const { binding } = input;
    const firstSendTextIndex = postLaunchFiles.findIndex((file) => file.deliveryHint === "send_text");
    const identityContext = `OpenRig-generated identity context (not a project task):\n${identityAction.value}\nEnd of generated identity context.`;
    let prompt = identityContext;
    let remainingFiles = postLaunchFiles;

    if (firstSendTextIndex !== -1) {
      const firstSendText = postLaunchFiles[firstSendTextIndex]!;
      try {
        const content = this.readFile(firstSendText.absolutePath);
        if (content.length > 0) {
          prompt = `${identityContext}\n\n${content}`;
          remainingFiles = postLaunchFiles.filter((_, index) => index !== firstSendTextIndex);
        }
      } catch {
        // Fall back to a standalone identity prompt and let the adapter handle
        // the original startup file using its normal failure semantics.
      }
    }

    if (firstSendTextIndex === -1 && !input.isRestore && !includeDurableObligations && !challengeBlock) {
      prompt += "\n\nFor this identity-only startup, run rig whoami --json and reply with your identity and readiness for an assignment. Repository history, tool descriptions and your own replies are not assignments.";
    }

    if (includeDurableObligations) prompt += `\n\nThis is a fresh conversation. Before choosing work, derive your identity with rig whoami --json and read durable obligations with rig queue list --destination ${binding.tmuxSession} --state pending,in-progress,blocked --limit 10000 --full --json. Report truncation at the limit; a destination row is not permission to claim unrelated work.`;

    // OPR.0.4.3.06 — the per-launch orientation challenge rides along with the
    // identity prompt (after the contract) so no extra send is added.
    if (challengeBlock) {
      prompt = `${prompt}\n\n${challengeBlock}`;
    }

    return { prompt, remainingFiles };
  }

  private async deliverInitialSessionPrompt(
    input: StartupDeliveryInput,
    identityAction: StartupAction,
    postLaunchFiles: ResolvedStartupFile[],
    challengeBlock: string | null,
    includeDurableObligations = false,
  ): Promise<{ ok: true; remainingFiles: ResolvedStartupFile[] } | { ok: false; error: string }> {
    const { binding } = input;
    if (!binding.tmuxSession) {
      return { ok: false, error: "No tmux session for the initial session identity prompt" };
    }

    const { prompt, remainingFiles } = this.composeInitialSessionPrompt(input, identityAction, postLaunchFiles, challengeBlock, includeDurableObligations);
    const sendError = await this.sendInteractiveText(input, prompt, "initial_identity");
    if (sendError) {
      return { ok: false, error: `Initial session identity prompt failed: ${sendError.error}` };
    }

    return { ok: true, remainingFiles };
  }

  /**
   * OPR.0.4.7.17 restore-order-correction. Deliver the after_ready send_text
   * preload action(s) as the single leading turn on a resumed restore, bundling
   * the first work-triggering send_text post-launch file (guidance/role.md)
   * behind them so "load skills BEFORE anything else" causally precedes the role
   * content in one submission. Returns the post-launch files still to deliver
   * normally (role.md removed once bundled).
   */
  private async deliverRestorePreloadPrompt(
    input: StartupDeliveryInput,
    preloadActions: StartupAction[],
    postLaunchFiles: ResolvedStartupFile[],
  ): Promise<{ ok: true; remainingFiles: ResolvedStartupFile[] } | { ok: false; error: string }> {
    const { binding } = input;
    if (!binding.tmuxSession) {
      return { ok: false, error: "No tmux session for the restore preload prompt" };
    }

    const parts = preloadActions.map((a) => a.value);
    let remainingFiles = postLaunchFiles;

    const firstSendTextIndex = postLaunchFiles.findIndex((file) => file.deliveryHint === "send_text");
    if (firstSendTextIndex !== -1) {
      const firstSendText = postLaunchFiles[firstSendTextIndex]!;
      try {
        const content = this.readFile(firstSendText.absolutePath);
        if (content.length > 0) {
          parts.push(content);
          remainingFiles = postLaunchFiles.filter((_, index) => index !== firstSendTextIndex);
        }
      } catch {
        // Leave role.md in postLaunchFiles for normal delivery; the preload
        // still leads as its own turn.
      }
    }

    const sendError = await this.sendInteractiveText(input, parts.join("\n\n"), "restore_preload");
    if (sendError) {
      return { ok: false, error: `Restore preload prompt failed: ${sendError.error}` };
    }

    return { ok: true, remainingFiles };
  }

  /**
   * Claude only: the challenge reached the seat inside a paste, which Claude won't act on alone.
   * One short line in the person's turn asks it to run the challenge's own command. Best-effort: a
   * failed send is a submission warning, never a startup failure. It is sent only after the startup
   * prompt was observed submitted: staged, unverified or unobservable input stays in the composer
   * for the operator, and nothing is typed on top of it.
   */
  private async sendProofInstruction(input: StartupDeliveryInput): Promise<void> {
    if (input.adapter.runtime !== "claude-code" || !input.binding.tmuxSession) return;
    if (!input.lastSubmissionConfirmed) {
      this.recordSubmissionWarning(input, startupProofHeldBackWarning(input.lastSubmissionUnconfirmedReason));
      return;
    }
    const failure = await this.sendInteractiveText(input, STARTUP_PROOF_INSTRUCTION_LINE, "startup_proof_instruction");
    if (failure) this.recordSubmissionWarning(input, `Startup proof instruction was not delivered: ${failure.error}`);
  }

  private recordSubmissionWarning(input: StartupDeliveryInput, reason: string, displayWarning?: string): void {
    input.submissionWarnings.push(reason);
    // Keep every observation in the ordinary result, including if a later file fails.
    input.warnings.push(displayWarning ?? (reason === input.stagedSubmissionWarning ? reason
      : `Startup submission unverified in ${input.binding.tmuxSession}: ${reason}`));
  }

  /** The result of a start whose turn the runtime refused: the seat hasn't read its startup context, which never reads as
   *  delivered. `continuable` keeps it pending for `rig seat continue` (the whole startup again). Otherwise the seat says
   *  why not: a new conversation names the fresh launch that delivers it; a resumed or forked one keeps its conversation,
   *  and is never told to relaunch blank. Later errors (`also`) are listed, never in its place. */
  private owedStartup(input: StartupDeliveryInput, refused: ReadinessResult, continuity: string, continuable: boolean, also: string[]): StartupResult {
    const held = input.heldInputs
      ? `${input.heldInputs} later startup input${input.heldInputs === 1 ? " wasn't" : "s weren't"} sent. ` : "";
    const why = input.oneShotSent ? "a one-shot startup action already ran and must not run twice"
      : input.refusedWithStagedInput ? "the next startup input may still be in the input box"
      : "this start was a restore, and continuing delivers a fresh start's context";
    return this.fail(input, "attention_required", [
      refused.reason ?? "The runtime refused a startup turn.",
      ...also,
      ...(input.refusedWithStagedInput ? [
        `OpenRig pasted the next startup input in ${input.binding.tmuxSession} but didn't press Enter, because Claude had refused the turn before it. It may still be in the input box, so don't resend it.${continuity !== "fresh" ? " Check the pane; clear it or send it after signing in." : ""}`,
      ] : []),
      continuable
        ? `${held}The seat hasn't read its startup context. Continuing delivers the whole startup again, the refused turn included.`
        : continuity !== "fresh"
          ? `${held}The seat's conversation is kept, but it hasn't read ${input.heldInputs ? (input.heldInputs === 1 ? "that input" : "those inputs") : "all of its startup context"}; continuing isn't offered for a ${continuity} start.`
          : `${held}The seat hasn't read all of its startup context, and continuing isn't offered: ${why}. To deliver it, launch the seat fresh: rig seat launch ${shellQuote(input.binding.tmuxSession ?? "<seat>")} --fresh --stop --reason "<why>".`,
    ], undefined, continuable, undefined, false, "post_delivery_readiness", true);
  }

  /** Whether the runtime refused the last startup turn: an attention readiness code now (Claude's "Login expired ·
   *  Please run /login" as its latest response reads login_required). An unavailable observation holds nothing back. */
  private async refusedTurn(input: StartupDeliveryInput): Promise<ReadinessResult | undefined> {
    try {
      const readiness = await input.adapter.checkReady(input.binding);
      return !readiness.ready && isAttentionRequiredReadinessCode(readiness.code) ? readiness : undefined;
    } catch {
      return undefined;
    }
  }

  private async sendInteractiveText(input: StartupDeliveryInput, text: string, source: StartupSubmissionDiagnostic["source"], actionIndex?: number): Promise<StartupSendFailure | null> {
    // After a refused turn nothing more is typed into the seat. The held input is counted, and startNode reports it as
    // owed (ahead of any later error) before it would mark the seat ready, so returning here never reads as delivered.
    if (input.adapter.runtime === "claude-code" && input.sendOrder > 0 && (input.refusedTurn ??= await this.refusedTurn(input))) {
      input.heldInputs = (input.heldInputs ?? 0) + 1;
      return null;
    }
    const sendOrder = ++input.sendOrder;
    const tmuxSession = input.binding.tmuxSession!;
    input.lastSubmissionConfirmed = false;
    input.lastSubmissionUnconfirmedReason = undefined;
    const firstPane = input.binding.tmuxPane;
    if (input.adapter.runtime === "claude-code" && sendOrder === 1 && !input.isRestore && firstPane) {
      await waitForClaudeInputBox(() => this.tmuxAdapter.capturePaneScreen(firstPane), this.sleep);
    }
    const textResult = await this.tmuxAdapter.sendText(tmuxSession, text);
    if (!textResult.ok) {
      return { error: (textResult as { message?: string }).message ?? "unknown" };
    }

    await this.sleep(200);
    // The previous turn can refuse after the pre-paste check. Leave our new paste alone rather than submitting it
    // into that refusal. It is already typed, not an unsent input, and must not be replayed by seat continue.
    if (input.adapter.runtime === "claude-code" && sendOrder > 1 && (input.refusedTurn ??= await this.refusedTurn(input))) {
      input.refusedWithStagedInput = true;
      input.lastSubmissionUnconfirmedReason = UNCONFIRMED_STAGED;
      return null;
    }
    const submitResult = await this.tmuxAdapter.sendKeys(tmuxSession, ["Enter"]);
    if (!submitResult.ok) {
      return { error: (submitResult as { message?: string }).message ?? "unknown" };
    }

    if (input.adapter.runtime !== "claude-code") return null;

    const diagnostic: StartupSubmissionDiagnostic = { startupAttemptId: input.startupAttemptId,
      sendOrder, source, ...(actionIndex === undefined ? {} : { actionIndex }), observations: [], retry: "not_run" };
    let phase: "initial" | "guarded_retry" | "after_retry" = "initial";
    const record = (pane: string | null, look?: number) => {
      const evidence = startupSubmissionEvidence(pane, text, STARTUP_SUBMIT_CAPTURE_LINES, input.adapter.runtime);
      if (evidence) diagnostic.observations.push({ ...evidence, phase, ...(look === undefined ? {} : { look }) });
      return evidence;
    };
    const unverified = (reason: string, operatorReason: string): null => {
      input.lastSubmissionUnconfirmedReason = operatorReason;
      this.recordSubmissionWarning(input, reason);
      return null; // An unavailable observation is not a failed delivery.
    };
    // tmux accepting Enter does not prove the TUI submitted a large bracketed paste.
    // Reuse submitOnly's content check and guarded retry; never repaste or resend.
    try {
      await this.sleep(200);
      const first = await this.tmuxAdapter.capturePaneContent(tmuxSession, STARTUP_SUBMIT_CAPTURE_LINES);
      if (!first?.trim()) { record(first); return unverified("Startup submission capture is unavailable after Enter.", UNCONFIRMED_UNOBSERVABLE); }
      const { pane, state: before, looks } = await settleOwnStartupPaste(
        () => this.tmuxAdapter.capturePaneContent(tmuxSession, STARTUP_SUBMIT_CAPTURE_LINES), first, text, input.adapter.runtime, this.sleep);
      if (before === "clear") { input.lastSubmissionConfirmed = true; return null; }
      if (before === "unverified") {
        if (looks) record(first, 0);
        const evidence = record(pane, looks || undefined);
        return unverified(evidence?.reason === "unrecognized_composer_boundary"
          ? "Startup submission is unverified: the current composer boundary was not recognized."
          : "Startup submission is unverified: the current composer does not positively match the complete prompt.",
        UNCONFIRMED_UNCLEAR);
      }
      let retry: Awaited<ReturnType<SessionTransport["send"]>>;
      let after: string | null;
      let observed: ReturnType<typeof inspectStartupStagedText>;
      let retries = 0;
      do {
        phase = "guarded_retry";
        diagnostic.retry = "threw"; // Replaced when the transport returns normally.
        retry = await this.sessionTransport.send(tmuxSession, "", {
          openrigNotice: true,
          submitOnly: true,
          expectedStagedText: text,
          submitOnlyCaptureLines: STARTUP_SUBMIT_CAPTURE_LINES,
          requireFullStagedText: true,
          onStartupMismatch: (evidence) => { diagnostic.observations.push({ ...evidence, phase: "guarded_retry" }); },
        });
        diagnostic.retry = retry.ok ? "ok" : "refused_or_failed";
        phase = "after_retry";
        await this.sleep(200);
        after = await this.tmuxAdapter.capturePaneContent(tmuxSession, STARTUP_SUBMIT_CAPTURE_LINES);
        if (!after?.trim()) { record(after); return unverified("Startup submission capture is unavailable after the guarded retry.", UNCONFIRMED_UNOBSERVABLE); }
        observed = inspectStartupStagedText(after, text, input.adapter.runtime);
        // A refused retry is not repeated; only a retry whose Enter went in and was lost again is.
      } while (observed === "staged" && retry.ok && ++retries < STARTUP_SUBMIT_RETRIES);
      if (observed === "staged") {
        const warning = `Startup prompt still staged in ${tmuxSession}; press Enter in that pane.`;
        input.stagedSubmissionWarning = warning;
        input.lastSubmissionUnconfirmedReason = UNCONFIRMED_STAGED;
        this.recordSubmissionWarning(input, warning);
        if (!retry.ok) this.recordSubmissionWarning(input, `Guarded retry did not submit: ${retry.error ?? retry.reason}`);
        return null;
      }
      if (observed === "unverified") {
        const evidence = record(after);
        return unverified(evidence?.reason === "unrecognized_composer_boundary"
          ? "Startup submission is unverified after the guarded retry: the current composer boundary was not recognized."
          : "Startup submission is unverified after the guarded retry: the current composer is ambiguous.",
        UNCONFIRMED_UNCLEAR);
      }
      if (!retry.ok) return unverified(`Guarded startup retry did not submit: ${retry.error ?? retry.reason}; matching staged text is no longer visible.`, UNCONFIRMED_RETRY_REFUSED);
      input.lastSubmissionConfirmed = true;
      return null;
    } catch (error) {
      if (!diagnostic.observations.some(observation => observation.phase === phase)) record(null);
      return unverified(`Startup submission observation is unavailable: ${(error as Error).message}`, UNCONFIRMED_UNOBSERVABLE);
    } finally {
      if (diagnostic.observations.length) input.submissionDiagnostics.push(diagnostic);
    }
  }
}

function isSessionIdentityAction(action: StartupAction): boolean {
  if (action.builtin === "session_identity") return true;
  return action.type === "send_text" && action.value.startsWith("OpenRig session identity:");
}
