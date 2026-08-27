// OPR.0.5.5.20 — DAEMON BIND PROVENANCE: the pure bind-plan resolver. Bind intent
// reaches the daemon ONLY through the dedicated OPENRIG_BIND_HOST surface; the
// overloaded routing env (OPENRIG_HOST/RIGGED_HOST — a client endpoint any managed
// environment may inject) can NEVER select the single-bind branch. The lived cost of
// the old conflation: the parent daemon inherited OPENRIG_HOST=127.0.0.1 from a
// maintenance command run in a managed environment and silently lost its Tailscale
// listener (operator baton qitem-20260827070400). This re-grounds the
// auth-bearer-tailscale-trust ruling — explicit opt-in vs default — on a channel that
// managed environments never inject; it does not overturn it.

export interface BindPlanInput {
  /** The DEDICATED bind-intent env (OPENRIG_BIND_HOST). Whitespace-only = absent. */
  bindHostEnv: string | undefined;
  /** The overloaded ROUTING env (OPENRIG_HOST/RIGGED_HOST) — observed for provenance
   *  honesty, never consulted for bind policy. */
  routingHostEnv: string | undefined;
  /** The active tailscale interface IP, when present. */
  tailscaleIp: string | null;
}

export interface BindPlan {
  mode: "explicit" | "default";
  hosts: string[];
  tailscaleDetected: boolean;
  /** Set when a routing env value was present and IGNORED for bind policy — the
   *  provenance line the daemon logs so the ignore is never silent. */
  ignoredRoutingHost?: string;
}

export function resolveBindPlan(input: BindPlanInput): BindPlan {
  const bindHost = input.bindHostEnv?.trim() || undefined;
  const routingHost = input.routingHostEnv?.trim() || undefined;
  const tailscaleDetected = input.tailscaleIp !== null;
  if (bindHost) {
    return { mode: "explicit", hosts: [bindHost], tailscaleDetected };
  }
  const hosts = input.tailscaleIp ? ["127.0.0.1", input.tailscaleIp] : ["127.0.0.1"];
  return {
    mode: "default",
    hosts,
    tailscaleDetected,
    ...(routingHost ? { ignoredRoutingHost: routingHost } : {}),
  };
}
