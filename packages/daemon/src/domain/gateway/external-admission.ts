// M1 A4b — @external entity-admission. Contract 2a57d099 (sealed): resolve a
// <local>@external destination against the human registry (A3). Home = the daemon
// gateway-path (topologyValidateRig / 4b, queue-side) + the A4 gateway (connector-side),
// arch-ruled 8cd30094. This module is the RESOLVER; the daemon-side registry READER
// (loads the projection entities) + the gate wiring consume it.
//
// The four ruled outcomes (never silent, NEVER an agent-class downgrade):
//   registered   mike@external            -> entity found (prefs applied downstream)
//   scheme        slack:U012AB3CD@external -> a one-off ADDRESS (never a registry entry;
//                                            connector #1 delivers it directly)
//   unregistered  stranger@external        -> LOUD structured teaching refusal
//   (unresolved inbound with no target)    -> the default HUMAN slot human-operator@kernel
//
// proof-2 captures BOTH refusal texts: the DOMAIN-level bounce (a token NOT in the
// closed set falls through to unknown_destination_rig, from A1/A2) AND the ENTITY-level
// teaching refusal here (valid @external domain, entity absent).

// The default HUMAN operator identity — re-exported from its canonical home in the
// human-registry (ONE source, no dup). See there for the concept-1/concept-2 note.
export { OPERATOR_HUMAN_DEFAULT_SLOT } from "./human-registry.js";

/** The identity a registered human contributes to admission (a projection of the A3
 *  fragment; the resolver only needs the key + address for admission). */
export interface RegisteredEntity {
  entityId: string;
  address: string; // <entityId>@external
}

export type ExternalResolution =
  | { kind: "registered"; entityId: string }
  | { kind: "scheme"; scheme: string; handle: string }
  | { kind: "unregistered"; local: string; error: string };


/** Resolve the `local` part of a `<local>@external` ref against the registered entities.
 *  A scheme form (`local` contains ':') is the literal-scheme mode — a one-off address,
 *  never a registry lookup. Otherwise the registered mode: `local` is the entityId. An
 *  absent entity is a LOUD structured teaching refusal, never a silent/agent-class fall. */
export function resolveExternal(local: string, entities: readonly RegisteredEntity[]): ExternalResolution {
  const colon = local.indexOf(":");
  if (colon > 0 && colon < local.length - 1) {
    return { kind: "scheme", scheme: local.slice(0, colon), handle: local.slice(colon + 1) };
  }
  const found = entities.find((e) => e.entityId === local);
  if (found) return { kind: "registered", entityId: found.entityId };
  return {
    kind: "unregistered",
    local,
    error:
      `'${local}@external' names no registered human (no gateway/humans/${local}.yaml fragment). ` +
      `Register the human first: rig gateway human add ${local} --display-name … --binding … --delivery-class …; ` +
      `or address a human that is already registered. ` +
      `(This is a virtual-domain reference — it was NOT downgraded to an agent seat.)`,
  };
}
