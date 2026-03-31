import type {
  RuntimeAdapter,
  InstalledResource,
  NodeBinding,
  ProjectionResult,
  StartupDeliveryResult,
  ReadinessResult,
  ResolvedStartupFile,
} from "../domain/runtime-adapter.js";
import type { ProjectionPlan } from "../domain/projection-planner.js";

/**
 * Terminal runtime adapter for infrastructure nodes.
 * All operations are no-ops — the shell is immediately interactive.
 * Startup actions (send_text) are handled by the startup orchestrator,
 * not by this adapter.
 */
export class TerminalAdapter implements RuntimeAdapter {
  readonly runtime = "terminal";

  async listInstalled(_binding: NodeBinding): Promise<InstalledResource[]> {
    return [];
  }

  async project(_plan: ProjectionPlan, _binding: NodeBinding): Promise<ProjectionResult> {
    return { projected: [], skipped: [], failed: [] };
  }

  async deliverStartup(_files: ResolvedStartupFile[], _binding: NodeBinding): Promise<StartupDeliveryResult> {
    return { delivered: 0, failed: [] };
  }

  async checkReady(_binding: NodeBinding): Promise<ReadinessResult> {
    return { ready: true };
  }
}
