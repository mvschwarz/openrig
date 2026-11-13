// The queue's production destination check: which session refs a queue row may be addressed to. Startup wires it into
// QueueRepository as validateRig; anything that must know whether a row would be accepted, without writing one, uses the
// same check (QueueRepository.acceptsDestination).
import { isHumanSeatSessionRef, parseSessionName } from "./session-name.js";
import { resolveExternal } from "./gateway/external-admission.js";
import type { LoadResult } from "./gateway/human-registry.js";
import { sharedChannelAddresses } from "./gateway/participants.js";

// PL-004 Phase A revision (R1): topology-backed validateRig.
// Canonical addresses remain recordable when topology is missing or unavailable.
// Destination observation is advice after persistence, not admission authority.
// Bare ids without `@` are also rejected
// (no canonical rig binding).
// OPR.0.4.6.MH1 FR-8: this gate is the ARCHETYPE consumer of the shared
// parse contract — human-seat classification BEFORE parse. The greedy
// first-@ spelling remains intact; local topology does not authorize or
// rewrite canonical destination addresses.
export function makeTopologyDestinationCheck(deps: {
  findRigsByName: (name: string) => unknown[];
  loadHumanRegistry: () => LoadResult;
  /** Registered shared channels, which are `<id>@external` participants too (0.7.3). Default: the participant file. */
  sharedChannels?: () => ReadonlyArray<{ entityId: string; address: string }>;
}): (sessionRef: string) => boolean {
  return (sessionRef: string): boolean => {
    const parsed = parseSessionName(sessionRef);
    // M1 A4b — @external entity-admission (checked BEFORE the human-CLASS bare-admit,
    // which A2 also makes true for <local>@external): a queue row destinationed to
    // <local>@external is admitted ONLY if the human is REGISTERED (or it is a literal
    // scheme address); an unregistered entity is REFUSED (the 4b site carries the
    // entity-level teaching via externalAdmissionTeaching). Admission is the gateway's
    // job, never the classifier's (arch 8cd30094).
    if (parsed.kind === "external") {
      const reg = deps.loadHumanRegistry();
      const entities = [
        ...(reg.ok ? reg.entities.map((e) => ({ entityId: e.entityId, address: e.address })) : []),
        ...(deps.sharedChannels ?? sharedChannelAddresses)(),
      ];
      return resolveExternal(parsed.local, entities).kind !== "unregistered";
    }
    if (isHumanSeatSessionRef(sessionRef)) return true;
    if (parsed.kind !== "canonical") return false;
    return true;
  };
}
