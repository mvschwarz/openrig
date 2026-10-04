import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { isClaudeResumeType } from "../adapters/claude-resume.js";
import type { StartupAction, StartupProofSelection } from "./types.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  ProjectionResult, StartupDeliveryResult, ForkSource,
} from "./runtime-adapter.js";
import { isAttentionRequiredReadinessCode, resolveConcreteHint } from "./runtime-adapter.js";
import type { ProjectionPlan } from "./projection-planner.js";
import { issueStartupChallenge, STARTUP_PROOF_INSTRUCTION_LINE } from "./startup-proof.js";
import { resolveStartupProof } from "./startup-resolver.js";
import { AppliedLaunchObservationStore } from "./applied-launch-observation-store.js";
import { NativePermissionStore } from "./native-permission-store.js";
import { RigRepository } from "./rig-repository.js";
import { SessionTransport, inspectStartupStagedText } from "./session-transport.js";
import { startupSubmissionEvidence, type StartupSubmissionDiagnostic } from "./startup-submission-evidence.js";
import type { AppliedLaunchObservation } from "./permission-drift.js";
import { resolveReadinessTimeoutMs } from "./readiness-timeout.js";
import { SettingsStore } from "./user-settings/settings-store.js";

// Expanded startup text can put the current input marker above 50 scrollback lines.
const STARTUP_SUBMIT_CAPTURE_LINES = 200;

// -- Types --

export interface StartupInput {
  rigId: string;
  nodeId: string;
  sessionId: string;
  binding: NodeBinding;
  adapter: RuntimeAdapter;
  plan: ProjectionPlan;
  resolvedStartupFiles: ResolvedStartupFile[];
  startupActions: StartupAction[];
  isRestore: boolean;
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
  /** Exact resume must not overwrite the authored fresh-start context with its empty replay plan. */
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
  startupAttemptId: string; sendOrder: number; submissionDiagnostics: StartupSubmissionDiagnostic[];
  /** Claude only: whether the latest interactive send was observed submitted (a clear composer). */
  lastSubmissionConfirmed?: boolean;
};

export type StartupResult =
  | { ok: true; startupStatus: "ready"; continuityOutcome: "resumed" | "fresh" | "forked" | "rebuilt"; submission?: { status: "unverified" | "staged"; reasons: string[]; warning?: string; diagnostics?: StartupSubmissionDiagnostic[] } }
  // `evidence` carries the last-N pane lines for `attention_required`
  // outcomes so restore-orchestrator's per-node mapping can populate
  // `attentionEvidence` on the RestoreNodeResult. Internal type only;
  // not persisted on the failure event.
  | { ok: false; startupStatus: "attention_required" | "failed"; errors: string[]; evidence?: string };

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

  async startNode(input: StartupInput): Promise<StartupResult> {
    const guard = this.tmuxAdapter.deliveryGuard;
    if (guard && !guard.ownsLifecycle(input.nodeId)) {
      return guard.lifecycle([input.nodeId], () => this.startNode(input));
    }
    try {
      input = { ...input, binding: new NativePermissionStore(this.db).apply(input.binding, input.adapter.runtime) };
    } catch (error) {
      return this.fail(input, "failed", [`Permission selection: ${(error as Error).message}`]);
    }
    // #25: launch, restore replay, relaunch, continue and added members deliver
    // guidance through here, so the rig's managed-block destination is bound once
    // for the adapter. Handover does not come here: the successor launches directly
    // and reads the file already written in its cwd.
    const claudeManagedBlockFile = new RigRepository(this.db).getRigClaudeManagedBlockFile(input.rigId);
    if (claudeManagedBlockFile) input = { ...input, binding: { ...input.binding, claudeManagedBlockFile } };
    const deliveryInput: StartupDeliveryInput = { ...input, submissionWarnings: [], startupAttemptId: randomUUID(), sendOrder: 0, submissionDiagnostics: [] };
    const errors: string[] = [];
    let continuityOutcome: "resumed" | "fresh" | "forked" | "rebuilt" = input.resumeToken
      ? "resumed"
      : input.forkSource
        ? "forked"
        : input.rebuildArtifacts && input.rebuildArtifacts.length > 0
          ? "rebuilt"
          : "fresh";
    let appliedLaunch: AppliedLaunchObservation | undefined;
    const launchGeneration = this.sessionRegistry.currentOccupantTenure(input.nodeId)?.generationUuid;

    // 1. Mark pending
    this.sessionRegistry.updateStartupStatus(input.sessionId, "pending");
    const context = input.isRestore ? "restore" : "fresh_start";
    let startupProof: StartupProofSelection;
    try {
      startupProof = resolveStartupProof(input.startupActions, context);
    } catch (err) {
      return this.fail(input, "failed", [`Startup proof selection: ${(err as Error).message}`]);
    }
    this.eventBus.emit({ type: "node.startup_pending", rigId: input.rigId, nodeId: input.nodeId, startupProof });

    // 2. Project resources
    let projectionResult: ProjectionResult;
    try {
      projectionResult = await input.adapter.project(input.plan, input.binding);
      if (projectionResult.failed.length > 0) {
        for (const f of projectionResult.failed) {
          errors.push(`Projection failed for ${f.effectiveId}: ${f.error}`);
        }
        return this.fail(input, "failed", errors);
      }
    } catch (err) {
      errors.push(`Projection error: ${(err as Error).message}`);
      return this.fail(input, "failed", errors);
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
    const applicableFiles = sourceFiles.filter((f) => f.appliesOn.includes(context));
    const preLaunchFiles: ResolvedStartupFile[] = [];
    let postLaunchFiles: ResolvedStartupFile[] = [];
    for (const f of applicableFiles) {
      const hint = f.deliveryHint === "auto"
        ? resolveConcreteHint(f.path, this.safeReadFile(f.absolutePath))
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
      if (deliveryResult.failed.length > 0) {
        for (const f of deliveryResult.failed) {
          errors.push(`Pre-launch file delivery failed: ${f.path}: ${f.error}`);
        }
        return this.fail(input, "failed", errors);
      }
    } catch (err) {
      errors.push(`Pre-launch delivery error: ${(err as Error).message}`);
      return this.fail(input, "failed", errors);
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
      return this.fail(input, "failed", [`Startup context persistence failed: ${String(error)}`]);
    }

    // 5. Launch harness (unless skipped for legacy nodes)
    if (!input.skipHarnessLaunch) {
      try {
        let launchResumeToken = input.resumeToken;
        let attemptedFreshFallback = false;

        while (true) {
          const launchResult = await input.adapter.launchHarness(input.binding, {
            name: input.sessionName ?? input.binding.tmuxSession ?? "",
            resumeToken: launchResumeToken,
            ...(input.forkSource && !launchResumeToken ? { forkSource: input.forkSource } : {}),
          });
          if (launchResult.ok) {
            appliedLaunch = launchResult.appliedLaunch;
            const normalizedResumeToken = launchResult.resumeToken?.trim();
            if (normalizedResumeToken) {
              try {
                this.sessionRegistry.updateResumeToken(input.sessionId, launchResult.resumeType ?? "", normalizedResumeToken, "scrape");
              } catch { /* best-effort */ }
            }
            break;
          }

          const shouldRetryFresh =
            !!launchResumeToken
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
            errors.push(`Harness launch requires attention: ${launchResult.error}`);
            // isRestore selects context, not native continuity: pod-aware exact
            // resume also uses false. Only an actual fresh launch may re-prime.
            return this.fail(input, "attention_required", errors, launchResult.evidence, continuityOutcome === "fresh");
          }

          errors.push(`Harness launch failed: ${launchResult.error}`);
          return this.fail(input, "failed", errors);
        }
      } catch (err) {
        errors.push(`Harness launch error: ${(err as Error).message}`);
        return this.fail(input, "failed", errors);
      }
    }

    // A successful new lean launch replaces the occupant's proof boundary even
    // if readiness later fails. Failed launches and resume/adopt retain history.
    const isFreshLaunch = continuityOutcome === "fresh" && (!input.skipHarnessLaunch || input.continueFreshStartup === true);
    const shouldChallenge = isFreshLaunch
      && input.adapter.runtime !== "terminal" && startupProof.mode === "authenticated";
    if (isFreshLaunch && !shouldChallenge) {
      this.eventBus.emit({
        type: "node.startup_proof_skipped", rigId: input.rigId, nodeId: input.nodeId,
        reason: input.adapter.runtime === "terminal" ? "terminal" : "not_selected",
      });
    }

    // 6. Wait for harness readiness within the configured launch window.
    try {
      const readinessTimeoutMs = resolveReadinessTimeoutMs(input.readinessTimeoutMs, this.readinessSettings);
      const readiness = await this.waitForReady(input.adapter, input.binding, readinessTimeoutMs);
      if (!readiness.ready) {
        if (isAttentionRequiredReadinessCode(readiness.code)) {
          errors.push(`Startup requires attention: ${readiness.reason ?? "unknown"}`);
          return this.fail(input, "attention_required", errors, undefined, isFreshLaunch);
        }
        errors.push(`Readiness timeout after ${readinessTimeoutMs / 1000}s — harness did not become interactive: ${readiness.reason ?? "unknown"}`);
        return this.fail(input, "failed", errors);
      }
    } catch (err) {
      errors.push(`Readiness check error: ${(err as Error).message}`);
      return this.fail(input, "failed", errors);
    }

    // The adapter returned the exact enforcing value it inserted, and readiness
    // proved this managed launch became live. Persistence is deliberately
    // best-effort: observation failure yields UNKNOWN, never a failed launch.
    if (appliedLaunch && launchGeneration) {
      this.appliedLaunchStore.recordGeneration(launchGeneration, appliedLaunch);
    }

    // Issue selected proof only once the runtime can receive its prompt.
    // Persist ground truth BEFORE delivering any proof prompt.
    const identityAction = this.extractSessionIdentityAction(input.startupActions, context);
    const challenge = shouldChallenge
      ? issueStartupChallenge(this.eventBus, {
          rigId: input.rigId,
          nodeId: input.nodeId,
          contractSource: JSON.stringify(input.resolvedStartupFiles),
        })
      : null;

    // A selected proof still works without a session_identity action: deliver
    // its standalone prompt after the post-launch contract files below.
    const consumedActions = new Set<StartupAction>();
    let challengeOnlyPrompt: string | null = null;
    if (continuityOutcome === "fresh" && identityAction) {
      const initialPrompt = await this.deliverInitialSessionPrompt(deliveryInput, identityAction, postLaunchFiles, challenge?.promptBlock ?? null, input.includeDurableObligations);
      if (!initialPrompt.ok) {
        errors.push(initialPrompt.error);
        return this.fail(input, "failed", errors);
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
          return this.fail(input, "failed", errors);
        }
        postLaunchFiles = preload.remainingFiles;
        for (const a of preloadActions) consumedActions.add(a);
      }
    }

    // 7. Deliver post-launch files (send_text → TUI, now that harness is ready)
    if (postLaunchFiles.length > 0) {
      try {
        const deliveryResult = await input.adapter.deliverStartup(postLaunchFiles, input.binding);
        if (deliveryResult.failed.length > 0) {
          for (const f of deliveryResult.failed) {
            errors.push(`Post-launch file delivery failed: ${f.path}: ${f.error}`);
          }
          return this.fail(deliveryInput, "failed", errors);
        }
      } catch (err) {
        errors.push(`Post-launch delivery error: ${(err as Error).message}`);
        return this.fail(deliveryInput, "failed", errors);
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
      return this.fail(deliveryInput, "failed", afterFilesResult.errors);
    }

    // 9. Execute after_ready actions (skipping any preload actions already
    // delivered ahead of role.md by the restore-order bundling above).
    const afterReadyResult = await this.executeActions(deliveryInput, "after_ready", consumedActions);
    if (!afterReadyResult.ok) {
      return this.fail(deliveryInput, "failed", afterReadyResult.errors);
    }

    // Delivering the first native prompt can reveal a provider refusal or
    // interactive gate. Bundled identity/preload prompts consume their files,
    // so the remaining file list alone does not tell us whether context was sent.
    if (postLaunchFiles.length > 0 || deliveryInput.sendOrder > 0) {
      try {
        const readiness = await input.adapter.checkReady(input.binding);
        if (!readiness.ready && isAttentionRequiredReadinessCode(readiness.code)) {
          return this.fail(deliveryInput, "attention_required", [readiness.reason ?? "The native provider prerequisite failed after context delivery."]);
        }
      } catch (error) {
        // An unavailable observation is not a positive provider prerequisite.
        deliveryInput.submissionWarnings.push(`Post-delivery runtime state is unverified: ${(error as Error).message}`);
      }
    }

    // Managed Claude resume needs agreement on the launched row, not a successful
    // scrape write: an equal hook/operator token may reject that lower-rank write.
    // Check after readiness/actions so a concurrent protected update is included.
    // Omitted type is inferred; claude_name may normalize to a proved claude_id.
    // An explicit type for another runtime is not that supported normalization.
    if (!input.skipHarnessLaunch && input.adapter.runtime === "claude-code"
      && continuityOutcome === "resumed" && input.resumeToken
      && ((input.resumeType !== undefined && !isClaudeResumeType(input.resumeType))
        || !this.sessionRegistry.resumeTokenMatches(input.sessionId, "claude_id", input.resumeToken.trim()))) {
      return this.fail(deliveryInput, "attention_required", [
        "Native resume was observed but its requested type or current session metadata conflicts or could not be retained; session preserved.",
      ]);
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

    return { ok: true, startupStatus: "ready", continuityOutcome, ...(submission ? { submission } : {}) };
  }

  /** A failed attempt can continue only when it stopped before sending context.
   * Any newer pending/ready/failure event consumes that permission, including a
   * daemon loss during delivery: uncertain delivery is never blindly replayed.
   */
  canContinueFresh(nodeId: string, sessionId: string): boolean {
    const row = this.db.prepare("SELECT payload FROM events WHERE node_id = ? AND type IN ('node.startup_pending', 'node.startup_ready', 'node.startup_failed') ORDER BY seq DESC LIMIT 1").get(nodeId) as { payload: string } | undefined;
    if (!row) return false;
    const event = JSON.parse(row.payload);
    return event.type === "node.startup_failed" && event.sessionId === sessionId && event.freshContextPending === true;
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
    freshContextPending = false,
  ): StartupResult {
    this.sessionRegistry.updateStartupStatus(input.sessionId, status);
    this.eventBus.emit({
      type: "node.startup_failed",
      rigId: input.rigId,
      nodeId: input.nodeId,
      error: errors.join("; "),
      sessionId: input.sessionId,
      ...(freshContextPending ? { freshContextPending: true } : {}),
      ...(input.submissionDiagnostics?.length ? { submissionDiagnostics: input.submissionDiagnostics } : {}),
    });
    return { ok: false, startupStatus: status, errors, evidence };
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
    }

    return errors.length > 0 ? { ok: false, errors } : { ok: true };
  }

  private extractSessionIdentityAction(
    actions: StartupAction[],
    context: "fresh_start" | "restore",
  ): StartupAction | null {
    return actions.find((action) => isSessionIdentityAction(action) && action.appliesOn.includes(context)) ?? null;
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

    const firstSendTextIndex = postLaunchFiles.findIndex((file) => file.deliveryHint === "send_text");
    let prompt = identityAction.value;
    let remainingFiles = postLaunchFiles;

    if (firstSendTextIndex !== -1) {
      const firstSendText = postLaunchFiles[firstSendTextIndex]!;
      try {
        const content = this.readFile(firstSendText.absolutePath);
        if (content.length > 0) {
          prompt = `${identityAction.value}\n\n${content}`;
          remainingFiles = postLaunchFiles.filter((_, index) => index !== firstSendTextIndex);
        }
      } catch {
        // Fall back to a standalone identity prompt and let the adapter handle
        // the original startup file using its normal failure semantics.
      }
    }

    if (includeDurableObligations) prompt += `\n\nThis is a fresh conversation. Before choosing work, derive your identity with rig whoami --json and read durable obligations with rig queue list --destination ${binding.tmuxSession} --state pending,in-progress,blocked --limit 10000 --full --json. Report truncation at the limit; a destination row is not permission to claim unrelated work.`;

    // OPR.0.4.3.06 — the per-launch orientation challenge rides along with the
    // identity prompt (after the contract) so no extra send is added.
    if (challengeBlock) {
      prompt = `${prompt}\n\n${challengeBlock}`;
    }

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
      input.submissionWarnings.push("Startup proof instruction was not sent: the startup prompt was not confirmed submitted.");
      return;
    }
    const failure = await this.sendInteractiveText(input, STARTUP_PROOF_INSTRUCTION_LINE, "startup_proof_instruction");
    if (failure) input.submissionWarnings.push(`Startup proof instruction was not delivered: ${failure.error}`);
  }

  private async sendInteractiveText(input: StartupDeliveryInput, text: string, source: StartupSubmissionDiagnostic["source"], actionIndex?: number): Promise<StartupSendFailure | null> {
    const sendOrder = ++input.sendOrder;
    const tmuxSession = input.binding.tmuxSession!;
    input.lastSubmissionConfirmed = false;
    const textResult = await this.tmuxAdapter.sendText(tmuxSession, text);
    if (!textResult.ok) {
      return { error: (textResult as { message?: string }).message ?? "unknown" };
    }

    await this.sleep(200);
    const submitResult = await this.tmuxAdapter.sendKeys(tmuxSession, ["Enter"]);
    if (!submitResult.ok) {
      return { error: (submitResult as { message?: string }).message ?? "unknown" };
    }

    if (input.adapter.runtime !== "claude-code") return null;

    const diagnostic: StartupSubmissionDiagnostic = { startupAttemptId: input.startupAttemptId,
      sendOrder, source, ...(actionIndex === undefined ? {} : { actionIndex }), observations: [], retry: "not_run" };
    let phase: "initial" | "guarded_retry" | "after_retry" = "initial";
    const record = (pane: string | null) => {
      const evidence = startupSubmissionEvidence(pane, text, STARTUP_SUBMIT_CAPTURE_LINES);
      if (evidence) diagnostic.observations.push({ ...evidence, phase });
      return evidence;
    };
    const unverified = (reason: string): null => {
      input.submissionWarnings.push(reason);
      return null; // An unavailable observation is not a failed delivery.
    };
    // tmux accepting Enter does not prove the TUI submitted a large bracketed paste.
    // Reuse submitOnly's content check and guarded retry; never repaste or loop.
    try {
      await this.sleep(200);
      const pane = await this.tmuxAdapter.capturePaneContent(tmuxSession, STARTUP_SUBMIT_CAPTURE_LINES);
      if (!pane?.trim()) { record(pane); return unverified("Startup submission capture is unavailable after Enter."); }
      const before = inspectStartupStagedText(pane, text);
      if (before === "clear") { input.lastSubmissionConfirmed = true; return null; }
      if (before === "unverified") {
        const evidence = record(pane);
        return unverified(evidence?.reason === "unrecognized_composer_boundary"
          ? "Startup submission is unverified: the current composer boundary was not recognized."
          : "Startup submission is unverified: the current composer does not positively match the complete prompt.");
      }
      phase = "guarded_retry";
      diagnostic.retry = "threw"; // Replaced when the transport returns normally.
      const retry = await this.sessionTransport.send(tmuxSession, "", {
        submitOnly: true,
        expectedStagedText: text,
        submitOnlyCaptureLines: STARTUP_SUBMIT_CAPTURE_LINES,
        requireFullStagedText: true,
        onStartupMismatch: (evidence) => { diagnostic.observations.push({ ...evidence, phase: "guarded_retry" }); },
      });
      diagnostic.retry = retry.ok ? "ok" : "refused_or_failed";
      phase = "after_retry";
      await this.sleep(200);
      const after = await this.tmuxAdapter.capturePaneContent(tmuxSession, STARTUP_SUBMIT_CAPTURE_LINES);
      if (!after?.trim()) { record(after); return unverified("Startup submission capture is unavailable after the guarded retry."); }
      const observed = inspectStartupStagedText(after, text);
      if (observed === "staged") {
        const warning = `Startup prompt still staged in ${tmuxSession}; press Enter in that pane.`;
        input.stagedSubmissionWarning = warning;
        input.submissionWarnings.push(warning);
        if (!retry.ok) input.submissionWarnings.push(`Guarded retry did not submit: ${retry.error ?? retry.reason}`);
        return null;
      }
      if (observed === "unverified") {
        const evidence = record(after);
        return unverified(evidence?.reason === "unrecognized_composer_boundary"
          ? "Startup submission is unverified after the guarded retry: the current composer boundary was not recognized."
          : "Startup submission is unverified after the guarded retry: the current composer is ambiguous.");
      }
      if (!retry.ok) return unverified(`Guarded startup retry did not submit: ${retry.error ?? retry.reason}; matching staged text is no longer visible.`);
      input.lastSubmissionConfirmed = true;
      return null;
    } catch (error) {
      if (!diagnostic.observations.some(observation => observation.phase === phase)) record(null);
      return unverified(`Startup submission observation is unavailable: ${(error as Error).message}`);
    } finally {
      if (diagnostic.observations.length) input.submissionDiagnostics.push(diagnostic);
    }
  }
}

function isSessionIdentityAction(action: StartupAction): boolean {
  if (action.builtin === "session_identity") return true;
  return action.type === "send_text" && action.value.startsWith("OpenRig session identity:");
}
