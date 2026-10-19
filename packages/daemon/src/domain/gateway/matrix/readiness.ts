import type { HumanFragment } from "../human-registry.js";
import type { HumanDeliveryReadiness } from "../human-readiness.js";
import { loadConfig } from "./config.js";
import { resolveAccessToken } from "./secrets.js";

/** Passive readiness never contacts a homeserver. Only an explicit matrix verify
 * establishes dated external evidence; /sync health is shown by matrix status. */
export function matrixHumanReadiness(home: string, human: HumanFragment, gatewayState: string): HumanDeliveryReadiness {
  const binding = human.connectorBindings.find((b) => b.role === "primary")!;
  let cfg: ReturnType<typeof loadConfig>;
  let configured: boolean;
  try {
    cfg = loadConfig(home);
    configured = !!cfg.homeserverUrl && !!resolveAccessToken({ envFile: cfg.secretsEnvFile });
  } catch (error) {
    return { state: "not-ready", ready: false, configured: false, enabled: false, active: false,
      connector: { kind: "matrix", ref: binding.connectorRef }, checkedAt: new Date().toISOString(),
      reason: `Matrix configuration unreadable: ${(error as Error).message}`, nextAction: "rig matrix status" };
  }
  const active = cfg.enabled && gatewayState === "active";
  return { state: configured && active ? "indeterminate" : "not-ready", ready: false, configured,
    enabled: cfg.enabled, active, connector: { kind: "matrix", ref: binding.connectorRef },
    checkedAt: new Date().toISOString(),
    reason: !configured ? "Matrix homeserver URL or access token missing" : !cfg.enabled ? "Matrix connector is disabled"
      : !active ? `gateway subsystem is ${gatewayState}` : "Matrix configured; external delivery has not been verified by this passive check",
    nextAction: !configured ? "rig matrix setup --help" : !cfg.enabled ? "rig matrix enable" : "rig matrix verify --join --send-test",
  };
}
