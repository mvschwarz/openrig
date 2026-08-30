// OPR.0.5.6.14 — THE one destination-classification seam.
//
// Every nudge/dispatch destination is classified exactly once, here:
//   pane-bound        → terminal transport (unchanged semantics)
//   gateway-routable  → the gateway subsystem owns delivery (the queue row is
//                       its input; its ledger is the delivery record; tmux is
//                       never consulted — it can never hold these addresses)
//   unroutable        → an honest structured teaching refusal; tmux is never
//                       consulted for an address it can never hold
//
// D3 forward-design (Q-e): a future channel-map layer EXTENDS this function
// (channel → rig|seat in front of thread → seat). It must never become a third
// resolver beside it — this is deliberately the single classification site the
// wake path consults.
//
// Class membership, in order:
//   1. `@external` addresses (registered entities AND literal-scheme one-offs)
//      are gateway-routable — the folded gateway-owned wake contract.
//      Registration/admission refusals stay at their existing admission layer;
//      classification here is about WHO OWNS TRANSPORT, not who is admitted.
//   2. A known topology seat (a sessions row, or a nodes-composed canonical
//      name) is pane-bound — terminal transport, including a registered human
//      seat with a real pane and its honest not-found outcomes when down.
//   3. Any remaining address the human registry resolves to a registered human
//      (canonical-form aliases like human-founder@kernel — the live 4-row
//      specimen class) is gateway-routable: a PANELLESS virtual identity whose
//      delivery rides the gateway, exactly like its @external address.
//   4. Anything else is unroutable, with teaching that names BOTH checks.
import { parseSessionName } from "../session-name.js";
import { resolveRegisteredHumanAddress, type HumanFragment } from "./human-registry.js";

export type DestinationClass =
  | { class: "pane-bound" }
  | { class: "gateway-routable"; resolvedHuman: string | null; via: "external-address" | "registry-alias" }
  | { class: "unroutable"; teaching: string };

export interface ClassifyDeps {
  /** Registered human entities (null/empty when the registry is absent/unreadable —
   *  classification degrades to external-address + topology checks only). */
  entities: readonly HumanFragment[] | null;
  /** Does this daemon's topology know the destination as a seat (live or past)? */
  isKnownSeat: (destination: string) => boolean;
}

export function classifyDestination(destination: string, deps: ClassifyDeps): DestinationClass {
  const parsed = parseSessionName(destination);
  if (parsed.kind === "external") {
    const resolved = deps.entities ? resolveRegisteredHumanAddress(destination, deps.entities) : null;
    return { class: "gateway-routable", resolvedHuman: resolved, via: "external-address" };
  }
  if (deps.isKnownSeat(destination)) {
    return { class: "pane-bound" };
  }
  const aliasResolved = deps.entities ? resolveRegisteredHumanAddress(destination, deps.entities) : null;
  if (aliasResolved) {
    return { class: "gateway-routable", resolvedHuman: aliasResolved, via: "registry-alias" };
  }
  return {
    class: "unroutable",
    teaching:
      `unroutable: '${destination}' is not a known seat on this daemon and names no registered human — ` +
      `no transport can hold this address (checked: topology sessions/nodes + the human registry). ` +
      `Fix the address, or register the human with \`rig gateway human add\`.`,
  };
}
