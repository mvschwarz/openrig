import type Database from "better-sqlite3";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { StartupAction } from "./types.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  ProjectionResult, StartupDeliveryResult,
} from "./runtime-adapter.js";
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
}

export type StartupResult =
  | { ok: true; startupStatus: "ready" }
  | { ok: false; startupStatus: "failed"; errors: string[] };

interface StartupOrchestratorDeps {
  db: Database.Database;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  tmuxAdapter: TmuxAdapter;
}

/**
 * Drives one node from projected resources to startup_status: ready.
 *
 * Sequence:
 * 1. Mark pending, emit node.startup_pending
 * 2. Project resources via adapter
 * 3. Deliver startup files via adapter
 * 4. Execute after_files actions
 * 5. Poll readiness via adapter.checkReady
 * 6. Execute after_ready actions
 * 7. Mark ready, emit node.startup_ready
 *
 * Failure leaves startup_status: failed, node visible.
 * The caller (AS-T08b instantiator) creates session + binding first via NodeLauncher,
 * then calls startNode() with the full startup payload.
 */
export class StartupOrchestrator {
  readonly db: Database.Database;
  private sessionRegistry: SessionRegistry;
  private eventBus: EventBus;
  private tmuxAdapter: TmuxAdapter;

  constructor(deps: StartupOrchestratorDeps) {
    if (deps.db !== deps.sessionRegistry.db) throw new Error("StartupOrchestrator: sessionRegistry must share the same db handle");
    if (deps.db !== deps.eventBus.db) throw new Error("StartupOrchestrator: eventBus must share the same db handle");
    this.db = deps.db;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.tmuxAdapter = deps.tmuxAdapter;
  }

  async startNode(input: StartupInput): Promise<StartupResult> {
    const errors: string[] = [];

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
        return this.fail(input, errors);
      }
    } catch (err) {
      errors.push(`Projection error: ${(err as Error).message}`);
      return this.fail(input, errors);
    }

    // 3. Deliver startup files (filtered by appliesOn)
    const context = input.isRestore ? "restore" : "fresh_start";
    const applicableFiles = input.resolvedStartupFiles.filter((f) => f.appliesOn.includes(context));
    let deliveryResult: StartupDeliveryResult;
    try {
      deliveryResult = await input.adapter.deliverStartup(applicableFiles, input.binding);
      if (deliveryResult.failed.length > 0) {
        for (const f of deliveryResult.failed) {
          errors.push(`Startup file delivery failed: ${f.path}: ${f.error}`);
        }
        return this.fail(input, errors);
      }
    } catch (err) {
      errors.push(`Startup delivery error: ${(err as Error).message}`);
      return this.fail(input, errors);
    }

    // 4. Execute after_files actions
    const afterFilesResult = await this.executeActions(input, "after_files");
    if (!afterFilesResult.ok) {
      return this.fail(input, afterFilesResult.errors);
    }

    // 5. Poll readiness
    try {
      const readiness = await input.adapter.checkReady(input.binding);
      if (!readiness.ready) {
        errors.push(`Harness not ready: ${readiness.reason ?? "unknown"}`);
        return this.fail(input, errors);
      }
    } catch (err) {
      errors.push(`Readiness check error: ${(err as Error).message}`);
      return this.fail(input, errors);
    }

    // 6. Execute after_ready actions
    const afterReadyResult = await this.executeActions(input, "after_ready");
    if (!afterReadyResult.ok) {
      return this.fail(input, afterReadyResult.errors);
    }

    // 7. Persist startup context for restore replay
    try {
      this.db.prepare(
        "INSERT OR REPLACE INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)"
      ).run(
        input.nodeId,
        JSON.stringify(input.plan.entries.map((e) => ({ category: e.category, effectiveId: e.effectiveId, sourceSpec: e.sourceSpec, sourcePath: e.sourcePath, resourcePath: e.resourcePath, absolutePath: e.absolutePath, mergeStrategy: e.mergeStrategy, target: e.target }))),
        JSON.stringify(input.resolvedStartupFiles),
        JSON.stringify(input.startupActions),
        input.adapter.runtime,
      );
    } catch { /* best-effort persistence */ }

    // 8. Mark ready
    this.sessionRegistry.updateStartupStatus(input.sessionId, "ready", new Date().toISOString());
    this.eventBus.emit({ type: "node.startup_ready", rigId: input.rigId, nodeId: input.nodeId });

    return { ok: true, startupStatus: "ready" };
  }

  private fail(input: StartupInput, errors: string[]): StartupResult {
    this.sessionRegistry.updateStartupStatus(input.sessionId, "failed");
    this.eventBus.emit({
      type: "node.startup_failed",
      rigId: input.rigId,
      nodeId: input.nodeId,
      error: errors.join("; "),
    });
    return { ok: false, startupStatus: "failed", errors };
  }

  private async executeActions(
    input: StartupInput,
    phase: "after_files" | "after_ready",
  ): Promise<{ ok: true } | { ok: false; errors: string[] }> {
    const errors: string[] = [];
    const context = input.isRestore ? "restore" : "fresh_start";

    for (const action of input.startupActions) {
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

        let text: string;
        if (action.type === "slash_command") {
          text = action.value; // e.g. "/rename implementer"
        } else {
          text = action.value; // send_text: raw text
        }

        const result = await this.tmuxAdapter.sendText(input.binding.tmuxSession, text);
        if (!result.ok) {
          errors.push(`Action failed (${action.type}): ${(result as { message?: string }).message ?? "unknown"}`);
        }
      } catch (err) {
        errors.push(`Action error (${action.type}): ${(err as Error).message}`);
      }
    }

    return errors.length > 0 ? { ok: false, errors } : { ok: true };
  }
}
