// OPR.0.5.6.14 — THE one destination-classification seam.
//
// Every nudge/dispatch destination is classified exactly once, here:
//   pane-bound        → terminal transport (unchanged semantics)
//   gateway-routable  → the gateway subsystem owns delivery (the queue row is
//                       its input; its ledger is the delivery record; tmux is
//                       never consulted — it can never hold these addresses)
//   hosted            → a hosted member (an outside tool on the team) whose
//                       authored roster entry declares a trigger: the wake rings it
//   unroutable        → an honest structured teaching refusal; tmux is never
//                       consulted for an address it can never hold
//
// D3 forward-design (Q-e), as settled on #192: the channel map does not change
// who owns transport, so it is not a class here. Its one resolver is
// slack/channel-map.ts, shared by every channel decision (outbound posting,
// `rig slack verify` and human delivery readiness); inbound channel routing
// belongs in slack/thread-routing.ts, in front of thread → seat, through that
// same module. Neither may become a third resolver beside this function — this
// is deliberately the single classification site the wake path consults.
//
// Class membership, in order:
//   1. `@external` addresses (registered entities AND literal-scheme one-offs)
//      are gateway-routable — the folded gateway-owned wake contract.
//      Registration/admission refusals stay at their existing admission layer;
//      classification here is about WHO OWNS TRANSPORT, not who is admitted.
//   2. A topology seat with an explicit tmux binding is pane-bound — terminal
//      transport, including a registered human seat with a real pane and its
//      honest not-found outcomes when down. A paneless/external_cli binding is
//      NOT terminal evidence merely because the seat exists in topology.
//   3. Any remaining address the human registry resolves to a registered human
//      (canonical-form aliases like human-founder@kernel — the live 4-row
//      specimen class) is gateway-routable: a PANELLESS virtual identity whose
//      delivery rides the gateway, exactly like its @external address.
//   4. A hosted member whose roster entry declares a trigger is hosted. One with no
//      trigger stays unroutable, so its person is told; its teaching says it reads the
//      queue when its owner next starts a session, not to fix the address.
//   5. Anything else is unroutable, with teaching that names BOTH checks.
import { parseSessionName } from "../session-name.js";
import type { RosterWake } from "../rosters.js";
import { resolveRegisteredHumanAddress, type HumanFragment } from "./human-registry.js";

export type DestinationClass =
  | { class: "pane-bound" }
  | { class: "gateway-routable"; resolvedHuman: string | null; via: "external-address" | "registry-alias" }
  | { class: "hosted"; wake: RosterWake }
  | { class: "unroutable"; teaching: string };

export interface ClassifyDeps {
  /** Registered human entities (null/empty when the registry is absent/unreadable —
   *  classification degrades to external-address + topology checks only). */
  entities: readonly HumanFragment[] | null;
  /** Does this daemon have an explicit terminal transport for the destination? */
  hasTerminalTransport: (destination: string) => boolean;
  /** The trigger a hosted member's roster entry declares, when it declares one. */
  hostedWake?: (destination: string) => RosterWake | null;
  /** Whether a roster lists the destination as a hosted member, trigger or not. */
  isHostedMember?: (destination: string) => boolean;
}

export function classifyDestination(destination: string, deps: ClassifyDeps): DestinationClass {
  const parsed = parseSessionName(destination);
  if (parsed.kind === "external") {
    const resolved = deps.entities ? resolveRegisteredHumanAddress(destination, deps.entities) : null;
    return { class: "gateway-routable", resolvedHuman: resolved, via: "external-address" };
  }
  if (deps.hasTerminalTransport(destination)) {
    return { class: "pane-bound" };
  }
  const aliasResolved = deps.entities ? resolveRegisteredHumanAddress(destination, deps.entities) : null;
  if (aliasResolved) {
    return { class: "gateway-routable", resolvedHuman: aliasResolved, via: "registry-alias" };
  }
  const wake = deps.hostedWake?.(destination) ?? null;
  if (wake) return { class: "hosted", wake };
  if (deps.isHostedMember?.(destination)) {
    // The member reads this teaching too: the address is right, and it isn't a person to register.
    return {
      class: "unroutable",
      teaching: `unroutable: '${destination}' is a hosted member with no wake trigger, so nothing can push work to it. ` +
        `It reads the queue when its owner next starts a session.`,
    };
  }
  return {
    class: "unroutable",
    teaching:
      `unroutable: '${destination}' has no terminal transport on this daemon and names no registered human — ` +
      `no transport can hold this address (checked: tmux bindings + the human registry). ` +
      `Fix the address, or register the human with \`rig gateway human add\`.`,
  };
}
