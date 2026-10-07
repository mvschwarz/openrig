import type { HumanFragment } from "./human-registry.js";
import type { SlackConnectorConfig } from "./slack/config.js";
import { verifyScopes, verifyChannelMembership, type ScopeVerdict } from "./slack/slack-api.js";
import { mappedChannels } from "./slack/channel-map.js";

export type HumanDeliveryReadinessState = "ready" | "not-ready" | "indeterminate";

export interface HumanDeliveryReadiness {
  state: HumanDeliveryReadinessState;
  configured: boolean;
  enabled: boolean;
  active: boolean;
  ready: boolean;
  connector: { kind: string; ref: string };
  reason: string;
  nextAction: string | null;
  checkedAt: string;
}

export interface HumanDeliveryReadinessInput {
  human: HumanFragment;
  config: SlackConnectorConfig;
  gatewayState: string;
  botToken: string | null;
}

export interface HumanDeliveryReadinessDeps {
  verifyScopes?: (token: string, required: string[]) => Promise<ScopeVerdict>;
  verifyMembership?: (token: string, channel: string) => Promise<{ ok: boolean; isMember: boolean; error?: string }>;
  now?: () => Date;
}

/** Resolve the registered human's PRIMARY binding to delivery truth in one record.
 * Connector details stay behind this transport-neutral shape; secrets never leave it. */
export async function resolveHumanDeliveryReadiness(
  input: HumanDeliveryReadinessInput,
  deps: HumanDeliveryReadinessDeps = {},
): Promise<HumanDeliveryReadiness> {
  const primary = input.human.connectorBindings.find((binding) => binding.role === "primary")!;
  const checkedAt = (deps.now?.() ?? new Date()).toISOString();
  const base = {
    connector: { kind: primary.kind, ref: primary.connectorRef },
    checkedAt,
  };
  const configured = primary.kind === "slack" && input.botToken !== null && input.config.channel !== null;
  const enabled = input.config.enabled;
  const active = enabled && input.gatewayState === "active";
  const result = (
    state: HumanDeliveryReadinessState,
    reason: string,
    nextAction: string | null,
  ): HumanDeliveryReadiness => ({ state, configured, enabled, active, ready: state === "ready", ...base, reason, nextAction });

  if (primary.kind !== "slack") return result("not-ready", `primary connector kind '${primary.kind}' is unsupported`, "rig gateway human show " + input.human.entityId + " --json");
  if (!input.botToken || !input.config.channel) return result("not-ready", "connector configuration is incomplete (bot token or channel missing)", "rig slack status --json");
  if (!enabled) return result("not-ready", "connector is configured but disabled", "rig slack enable");
  if (input.gatewayState !== "active") return result("not-ready", `gateway subsystem is ${input.gatewayState}`, "rig daemon logs");
  if (input.config.outboundDestinations.length > 0 && !input.config.outboundDestinations.includes(input.human.address)) {
    return result("not-ready", `registered address ${input.human.address} is excluded by connector policy`, "rig slack status --json");
  }

  try {
    const scope = await (deps.verifyScopes ?? ((token, required) => verifyScopes(token, required)))(
      input.botToken,
      [...new Set([...input.config.requiredScopes, "chat:write"])],
    );
    if (!scope.ok) {
      return scope.error
        ? result("indeterminate", `scope verification unavailable: ${scope.error}`, "rig slack verify --json")
        : result("not-ready", `connector is missing required scopes: ${scope.missing.join(", ")}`, "rig slack verify --json");
    }
    // #192: membership in every channel the connector posts to (the default plus each mapped
    // channel), the same set `rig slack verify` checks. With no map this is the default alone.
    const verifyMembership = deps.verifyMembership ?? ((token, channel) => verifyChannelMembership(token, channel));
    const channels = mappedChannels(input.config);
    const missing: string[] = [];
    const unavailable: string[] = [];
    for (const c of channels) {
      const membership = await verifyMembership(input.botToken, c.channel);
      const label = c.isDefault ? "its configured channel" : `mapped channel ${c.channel} (${c.matches.join(", ")})`;
      if (!membership.ok) unavailable.push(c.isDefault ? membership.error ?? "unknown error" : `${c.channel}: ${membership.error ?? "unknown error"}`);
      else if (!membership.isMember) missing.push(label);
    }
    // A known non-member decides it: posts there would fail whatever the unavailable checks say.
    if (missing.length) return result("not-ready", `connector is not a member of ${missing.join("; ")}`, "rig slack verify --json");
    if (unavailable.length) return result("indeterminate", `channel membership verification unavailable: ${unavailable.join("; ")}`, "rig slack verify --json");
    return result("ready", channels.length > 1
      ? `required scopes and channel membership verified (${channels.length} channels)`
      : "required scopes and channel membership verified", null);
  } catch (error) {
    return result("indeterminate", `connector readiness could not be verified: ${(error as Error).message}`, "rig slack verify --json");
  }
}
