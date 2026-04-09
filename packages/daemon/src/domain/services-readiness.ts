import type { ComposeServicesAdapter, ComposeServiceStatus } from "../adapters/compose-services-adapter.js";
import type { RigServicesWaitTarget } from "./types.js";

export interface WaitTargetResult {
  target: RigServicesWaitTarget;
  status: "healthy" | "unhealthy" | "pending";
  detail: string | null;
}

/**
 * Shared readiness evaluator. ONE place for wait-target evaluation and derived
 * env health logic. Called by:
 * - boot-time health gate
 * - background health monitor (future)
 * - rig env status (future)
 * - rig ps env summary (future)
 */
export async function evaluateWaitTargets(
  targets: RigServicesWaitTarget[],
  adapter: ComposeServicesAdapter,
  composeStatuses?: ComposeServiceStatus[],
): Promise<WaitTargetResult[]> {
  const results: WaitTargetResult[] = [];

  for (const target of targets) {
    if (target.url) {
      // HTTP probe
      const ok = await adapter.probeHttp(target.url);
      results.push({
        target,
        status: ok ? "healthy" : "unhealthy",
        detail: ok ? null : `HTTP probe failed: ${target.url}`,
      });
    } else if (target.tcp) {
      // TCP probe
      const ok = await adapter.probeTcp(target.tcp);
      results.push({
        target,
        status: ok ? "healthy" : "unhealthy",
        detail: ok ? null : `TCP probe failed: ${target.tcp}`,
      });
    } else if (target.condition === "healthy" && target.service) {
      // Compose health check — look at compose ps output
      const svc = composeStatuses?.find((s) => s.name === target.service);
      if (!svc) {
        results.push({ target, status: "unhealthy", detail: `Service '${target.service}' not found in compose status` });
      } else if (svc.health === "healthy") {
        results.push({ target, status: "healthy", detail: null });
      } else {
        results.push({ target, status: svc.health === "starting" ? "pending" : "unhealthy", detail: `Service '${target.service}' health: ${svc.health ?? svc.state}` });
      }
    } else {
      results.push({ target, status: "unhealthy", detail: "Unknown wait target type" });
    }
  }

  return results;
}

/** Derive overall env health from wait target results. */
export function deriveEnvHealth(results: WaitTargetResult[]): "healthy" | "degraded" | "unhealthy" {
  if (results.length === 0) return "healthy";
  const allHealthy = results.every((r) => r.status === "healthy");
  if (allHealthy) return "healthy";
  const anyHealthy = results.some((r) => r.status === "healthy");
  return anyHealthy ? "degraded" : "unhealthy";
}
