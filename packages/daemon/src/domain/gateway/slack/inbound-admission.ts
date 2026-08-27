// M1 A6 v3 — wire the inbound registration gate to the daemon human-registry. Kept as a pure
// factory (the registry surface is injected) so it is unit-testable without the daemon and the
// actual daemon import stays LAZY at the call site (dep rail). Maps a registry lookup to the
// InboundRouter's InboundSenderResolution:
//   - registry load FAILS   -> REFUSE, fail-CLOSED, surfacing reg.error (r1 A4b follow-on: a
//                              broken registry is distinct from an absent entity; never fabricate
//                              a human seat because we could not check).
//   - sender REGISTERED     -> admit; source = the registered human's @external address.
//   - sender UNREGISTERED   -> REFUSE with the resolver's LOUD teaching.

import type { InboundSenderResolution } from "./inbound.js";
// S10 re-home: this module now lives IN the daemon, so the registry surface types resolve
// relatively (the lazy-import dep rail was a CLI concern; the injectable surface stays for tests).
import type { loadHumanRegistry as LoadFn, resolveSlackHandle as ResolveFn } from "../human-registry.js";

export interface RegistrySurface {
  loadHumanRegistry: typeof LoadFn;
  resolveSlackHandle: typeof ResolveFn;
}

export function makeInboundSenderResolver(reg: RegistrySurface, home?: string): (slackUserId: string) => InboundSenderResolution {
  return (slackUserId) => {
    const loaded = reg.loadHumanRegistry(home);
    if (!loaded.ok) {
      return { admitted: false, teaching: `human registry unavailable — inbound refused (fail-closed): ${loaded.error}` };
    }
    const r = reg.resolveSlackHandle(slackUserId, loaded.entities);
    return r.kind === "registered" ? { admitted: true, source: r.address } : { admitted: false, teaching: r.error };
  };
}
