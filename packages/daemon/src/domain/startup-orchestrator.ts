import type Database from "better-sqlite3";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { StartupAction } from "./types.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  ProjectionResult, StartupDeliveryResult,
} from "./runtime-adapter.js";
import { isAttentionRequiredReadinessCode, resolveConcreteHint } from "./runtime-adapter.js";
import type { ProjectionPlan } from "./projection-planner.js";

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
  /** Resume token for restore path. */
  resumeToken?: string;
  /** Skip harness launch (legacy nodes that already resumed via old helpers). */
  skipHarnessLaunch?: boolean;
  /** Allow runtime adapter retry_fresh fallback when native resume data is stale. */
  allowFreshFallback?: boolean;
  /** Readiness timeout in ms (default 30000). */
  readinessTimeoutMs?: number;
}

export type StartupResult =
  | { ok: true; startupStatus: "ready"; continuityOutcome: "resumed" | "fresh" }
  | { ok: false; startupStatus: "attention_required" | "failed"; errors: string[] };

interface StartupOrchestratorDeps {
  db: Database.Database;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  tmuxAdapter: TmuxAdapter;
  /** Read file content for concrete-hint resolution. */
  readFile?: (path: string) => string;
  /** Sleep between paste and submit for tmux-driven TUIs. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Drives one node from projected resources to startup_status: ready.
 *
 * Sequence (NS-T05):
 * 1. Mark pending, emit node.startup_pending
 * 2. Project resources (filesystem)
 * 3. Deliver pre-launch files (guidance_merge, skill_install → filesystem)
 * 4. Launch harness via adapter.launchHarness()
 * 5. Wait for harness ready (retry with exponential backoff, 30s timeout)
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

  constructor(deps: StartupOrchestratorDeps) {
    if (deps.db !== deps.sessionRegistry.db) throw new Error("StartupOrchestrator: sessionRegistry must share the same db handle");
    if (deps.db !== deps.eventBus.db) throw new Error("StartupOrchestrator: eventBus must share the same db handle");
    this.db = deps.db;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.readFile = deps.readFile ?? (() => "");
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private readFile: (path: string) => string;

  async startNode(input: StartupInput): Promise<StartupResult> {
    const errors: string[] = [];
    let continuityOutcome: "resumed" | "fresh" = input.resumeToken ? "resumed" : "fresh";

    // 1. Mark pending
    this.sessionRegistry.updateStartupStatus(input.sessionId, "pending");
    this.eventBus.emit({ type: "node.startup_pending", rigId: input.rigId, nodeId: input.nodeId });

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
    const context = input.isRestore ? "restore" : "fresh_start";
    const applicableFiles = input.resolvedStartupFiles.filter((f) => f.appliesOn.includes(context));
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

    // 5. Launch harness (unless skipped for legacy nodes)
    if (!input.skipHarnessLaunch) {
      try {
        let launchResumeToken = input.resumeToken;
        let attemptedFreshFallback = false;

        while (true) {
          const launchResult = await input.adapter.launchHarness(input.binding, {
            name: input.sessionName ?? input.binding.tmuxSession ?? "",
            resumeToken: launchResumeToken,
          });
          if (launchResult.ok) {
            const normalizedResumeToken = launchResult.resumeToken?.trim();
            if (normalizedResumeToken) {
              try {
                this.sessionRegistry.updateResumeToken(input.sessionId, launchResult.resumeType ?? "", normalizedResumeToken);
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

          errors.push(`Harness launch failed: ${launchResult.error}`);
          return this.fail(input, "failed", errors);
        }
      } catch (err) {
        errors.push(`Harness launch error: ${(err as Error).message}`);
        return this.fail(input, "failed", errors);
      }
    }

    // 6. Wait for harness readiness (retry with exponential backoff, 30s timeout)
    try {
      const readiness = await this.waitForReady(input.adapter, input.binding, input.readinessTimeoutMs ?? 30_000);
      if (!readiness.ready) {
        if (isAttentionRequiredReadinessCode(readiness.code)) {
          errors.push(`Startup requires attention: ${readiness.reason ?? "unknown"}`);
          return this.fail(input, "attention_required", errors);
        }
        errors.push(`Readiness timeout after 30s — harness did not become interactive: ${readiness.reason ?? "unknown"}`);
        return this.fail(input, "failed", errors);
      }
    } catch (err) {
      errors.push(`Readiness check error: ${(err as Error).message}`);
      return this.fail(input, "failed", errors);
    }

    const identityAction = this.extractSessionIdentityAction(input.startupActions, context);
    if (continuityOutcome === "fresh" && identityAction) {
      const initialPrompt = await this.deliverInitialSessionPrompt(input.binding, identityAction, postLaunchFiles);
      if (!initialPrompt.ok) {
        errors.push(initialPrompt.error);
        return this.fail(input, "failed", errors);
      }
      postLaunchFiles = initialPrompt.remainingFiles;
    }

    // 7. Deliver post-launch files (send_text → TUI, now that harness is ready)
    if (postLaunchFiles.length > 0) {
      try {
        const deliveryResult = await input.adapter.deliverStartup(postLaunchFiles, input.binding);
        if (deliveryResult.failed.length > 0) {
          for (const f of deliveryResult.failed) {
            errors.push(`Post-launch file delivery failed: ${f.path}: ${f.error}`);
          }
          return this.fail(input, "failed", errors);
        }
      } catch (err) {
        errors.push(`Post-launch delivery error: ${(err as Error).message}`);
        return this.fail(input, "failed", errors);
      }
    }

    // 8. Execute after_files actions
    const afterFilesResult = await this.executeActions(input, "after_files");
    if (!afterFilesResult.ok) {
      return this.fail(input, "failed", afterFilesResult.errors);
    }

    // 9. Execute after_ready actions
    const afterReadyResult = await this.executeActions(input, "after_ready");
    if (!afterReadyResult.ok) {
      return this.fail(input, "failed", afterReadyResult.errors);
    }

    // 7. Persist startup context for restore replay
    try {
      this.db.prepare(
        "INSERT OR REPLACE INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)"
      ).run(
        input.nodeId,
        JSON.stringify(input.plan.entries.map((e) => ({ category: e.category, effectiveId: e.effectiveId, sourceSpec: e.sourceSpec, sourcePath: e.sourcePath, resourcePath: e.resourcePath, absolutePath: e.absolutePath, resourceType: e.resourceType, mergeStrategy: e.mergeStrategy, target: e.target }))),
        JSON.stringify(input.resolvedStartupFiles),
        JSON.stringify(input.startupActions),
        input.adapter.runtime,
      );
    } catch { /* best-effort persistence */ }

    // 8. Mark ready
    this.sessionRegistry.updateStartupStatus(input.sessionId, "ready", new Date().toISOString());
    this.eventBus.emit({ type: "node.startup_ready", rigId: input.rigId, nodeId: input.nodeId });

    return { ok: true, startupStatus: "ready", continuityOutcome };
  }

  /**
   * Wait for harness readiness with exponential backoff.
   * Backoff: 1s → 2s → 4s → 8s → 16s (capped), total timeout default 30s.
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

      const elapsed = Date.now() - startTime;
      if (elapsed + delay > timeoutMs) {
        // One final check before timing out
        const finalResult = await adapter.checkReady(binding);
        if (finalResult.ready) return finalResult;
        return { ready: false, reason: result.reason ?? "readiness timeout" };
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, maxDelay);
    }
  }

  private safeReadFile(path: string): string {
    try { return this.readFile(path); } catch { return ""; }
  }

  private fail(
    input: StartupInput,
    status: "attention_required" | "failed",
    errors: string[],
  ): StartupResult {
    this.sessionRegistry.updateStartupStatus(input.sessionId, status);
    this.eventBus.emit({
      type: "node.startup_failed",
      rigId: input.rigId,
      nodeId: input.nodeId,
      error: errors.join("; "),
    });
    return { ok: false, startupStatus: status, errors };
  }

  private async executeActions(
    input: StartupInput,
    phase: "after_files" | "after_ready",
  ): Promise<{ ok: true } | { ok: false; errors: string[] }> {
    const errors: string[] = [];
    const context = input.isRestore ? "restore" : "fresh_start";

    for (const action of input.startupActions) {
      if (isSessionIdentityAction(action)) continue;

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

        const sendError = await this.sendInteractiveText(input.binding.tmuxSession, action.value);
        if (sendError) {
          errors.push(`Action failed (${action.type}): ${sendError}`);
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
    binding: NodeBinding,
    identityAction: StartupAction,
    postLaunchFiles: ResolvedStartupFile[],
  ): Promise<{ ok: true; remainingFiles: ResolvedStartupFile[] } | { ok: false; error: string }> {
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

    const sendError = await this.sendInteractiveText(binding.tmuxSession, prompt);
    if (sendError) {
      return { ok: false, error: `Initial session identity prompt failed: ${sendError}` };
    }

    return { ok: true, remainingFiles };
  }

  private async sendInteractiveText(tmuxSession: string, text: string): Promise<string | null> {
    const textResult = await this.tmuxAdapter.sendText(tmuxSession, text);
    if (!textResult.ok) {
      return (textResult as { message?: string }).message ?? "unknown";
    }

    await this.sleep(200);
    const submitResult = await this.tmuxAdapter.sendKeys(tmuxSession, ["C-m"]);
    if (!submitResult.ok) {
      return (submitResult as { message?: string }).message ?? "unknown";
    }

    return null;
  }
}

function isSessionIdentityAction(action: StartupAction): boolean {
  if (action.builtin === "session_identity") return true;
  return action.type === "send_text" && action.value.startsWith("OpenRig session identity:");
}
