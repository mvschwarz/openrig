import type { RigRepository } from "./rig-repository.js";
import type { ComposeServicesAdapter } from "../adapters/compose-services-adapter.js";
import type { RigServicesSpec, RigServicesRecord, EnvReceipt } from "./types.js";
import { evaluateWaitTargets, deriveEnvHealth } from "./services-readiness.js";

export type ServiceBootResult =
  | { ok: true; receipt: EnvReceipt; health: "healthy" | "degraded" }
  | { ok: false; code: string; error: string; receipt?: EnvReceipt };

export type ServiceTeardownResult =
  | { ok: true }
  | { ok: false; code: string; error: string };

interface ServiceOrchestratorDeps {
  rigRepo: RigRepository;
  composeAdapter: ComposeServicesAdapter;
}

/**
 * Leaf service called by existing orchestrators (bootstrap, teardown, restore).
 * Does NOT independently manage boot/teardown timing — callers decide when.
 */
export class ServiceOrchestrator {
  private rigRepo: RigRepository;
  private composeAdapter: ComposeServicesAdapter;

  constructor(deps: ServiceOrchestratorDeps) {
    this.rigRepo = deps.rigRepo;
    this.composeAdapter = deps.composeAdapter;
  }

  /**
   * Boot services for a rig. Called by bootstrap orchestrator as a stage before agent launch.
   * 1. Load persisted services record
   * 2. Run docker compose up
   * 3. Evaluate wait targets
   * 4. Persist receipt
   */
  async boot(rigId: string, opts?: { waitTimeoutMs?: number; waitPollIntervalMs?: number }): Promise<ServiceBootResult> {
    const record = this.rigRepo.getServicesRecord(rigId);
    if (!record) {
      return { ok: false, code: "no_services", error: "No services record found for this rig" };
    }

    const spec = this.parseSpec(record);
    if (!spec) {
      return { ok: false, code: "invalid_spec", error: "Could not parse persisted services spec" };
    }

    // 1. Launch compose services
    const upResult = await this.composeAdapter.up({
      composeFile: record.composeFile,
      projectName: record.projectName,
      profiles: spec.profiles,
    });

    if (!upResult.ok) {
      return { ok: false, code: upResult.code, error: upResult.message };
    }

    // 2. Evaluate wait targets with polling
    const waitTargets = spec.waitFor ?? [];
    if (waitTargets.length > 0) {
      const timeoutMs = opts?.waitTimeoutMs ?? 60_000;
      const pollMs = opts?.waitPollIntervalMs ?? 3_000;
      const start = Date.now();

      while (true) {
        // Get current compose status for condition:healthy targets
        const statusResult = await this.composeAdapter.status({
          composeFile: record.composeFile,
          projectName: record.projectName,
          profiles: spec.profiles,
        });

        if (!statusResult.ok) {
          const elapsed = Date.now() - start;
          if (elapsed + pollMs > timeoutMs) {
            return {
              ok: false,
              code: "compose_status_failed",
              error: statusResult.error ?? "Failed to read docker compose status",
            };
          }

          await new Promise((r) => setTimeout(r, pollMs));
          continue;
        }

        const waitResults = await evaluateWaitTargets(
          waitTargets,
          this.composeAdapter,
          statusResult.services,
        );

        const health = deriveEnvHealth(waitResults);
        if (health === "healthy") {
          // All targets healthy — capture receipt and return
          const receipt = this.buildReceipt(record, statusResult.services, waitResults);
          this.rigRepo.updateServicesReceipt(rigId, JSON.stringify(receipt));
          return { ok: true, receipt, health: "healthy" };
        }

        const elapsed = Date.now() - start;
        if (elapsed + pollMs > timeoutMs) {
          // Timeout — persist partial receipt honestly
          const receipt = this.buildReceipt(record, statusResult.services, waitResults);
          this.rigRepo.updateServicesReceipt(rigId, JSON.stringify(receipt));
          const failedTargets = waitResults.filter((r) => r.status !== "healthy");
          const failedNames = failedTargets.map((r) => r.detail ?? JSON.stringify(r.target)).join("; ");
          return { ok: false, code: "wait_timeout", error: `Service wait targets not healthy after ${Math.round(timeoutMs / 1000)}s: ${failedNames}`, receipt };
        }

        await new Promise((r) => setTimeout(r, pollMs));
      }
    }

    // No wait targets — just capture receipt
    const statusResult = await this.composeAdapter.status({
      composeFile: record.composeFile,
      projectName: record.projectName,
      profiles: spec.profiles,
    });
    if (!statusResult.ok) {
      return {
        ok: false,
        code: "compose_status_failed",
        error: statusResult.error ?? "Failed to read docker compose status",
      };
    }
    const receipt = this.buildReceipt(record, statusResult.services, []);
    this.rigRepo.updateServicesReceipt(rigId, JSON.stringify(receipt));
    return { ok: true, receipt, health: "healthy" };
  }

  /**
   * Tear down services for a rig. Called by teardown orchestrator during rig down.
   * Honors down_policy from the persisted spec.
   */
  async teardown(rigId: string, opts?: { policyOverride?: "down" | "down_and_volumes" | "leave_running" }): Promise<ServiceTeardownResult> {
    const record = this.rigRepo.getServicesRecord(rigId);
    if (!record) {
      return { ok: true }; // No services — nothing to tear down
    }

    const spec = this.parseSpec(record);
    const policy = opts?.policyOverride ?? spec?.downPolicy ?? "down";

    const result = await this.composeAdapter.down({
      composeFile: record.composeFile,
      projectName: record.projectName,
      profiles: spec?.profiles,
      policy,
    });

    if (!result.ok) {
      return { ok: false, code: result.code, error: result.message };
    }

    // Update receipt to reflect teardown
    this.rigRepo.updateServicesReceipt(rigId, null);
    return { ok: true };
  }

  /**
   * Capture a fresh receipt from current compose state. Called by snapshot capture.
   */
  async captureReceipt(rigId: string): Promise<EnvReceipt | null> {
    const record = this.rigRepo.getServicesRecord(rigId);
    if (!record) return null;

    const spec = this.parseSpec(record);
    const statusResult = await this.composeAdapter.status({
      composeFile: record.composeFile,
      projectName: record.projectName,
      profiles: spec?.profiles,
    });
    if (!statusResult.ok) {
      throw new Error(statusResult.error ?? "Failed to read docker compose status");
    }

    const waitTargets = spec?.waitFor ?? [];
    const waitResults = waitTargets.length > 0
      ? await evaluateWaitTargets(waitTargets, this.composeAdapter, statusResult.services)
      : [];

    const receipt = this.buildReceipt(record, statusResult.services, waitResults);
    this.rigRepo.updateServicesReceipt(rigId, JSON.stringify(receipt));
    return receipt;
  }

  // -- Private helpers --

  private parseSpec(record: RigServicesRecord): RigServicesSpec | null {
    try {
      return JSON.parse(record.specJson) as RigServicesSpec;
    } catch {
      return null;
    }
  }

  private buildReceipt(
    record: RigServicesRecord,
    services: Array<{ name: string; state: string; status: string; health: string | null }>,
    waitResults: Array<{ target: import("./types.js").RigServicesWaitTarget; status: string; detail: string | null }>,
  ): EnvReceipt {
    return {
      kind: "compose",
      composeFile: record.composeFile,
      projectName: record.projectName,
      services: services.map((s) => ({ name: s.name, status: s.state, health: s.health })),
      waitFor: waitResults.map((r) => ({
        target: r.target,
        status: r.status as "healthy" | "unhealthy" | "pending",
        detail: r.detail,
      })),
      capturedAt: new Date().toISOString(),
    };
  }
}
