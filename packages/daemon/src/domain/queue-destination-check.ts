// The existing topology-backed destination preflight, used when choosing a receiver.
// Recording canonical work is separate: absence must not prevent keeping the row.
import { isHumanSeatSessionRef, parseSessionName } from "./session-name.js";
import { resolveExternal } from "./gateway/external-admission.js";
import type { LoadResult } from "./gateway/human-registry.js";
import { sharedChannelAddresses } from "./gateway/participants.js";

// Human and external admission still use their registered-address rules.
// Bare ids without a canonical rig binding remain outside this address contract.
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
    return deps.findRigsByName(parsed.rig).length > 0;
  };
}

/** Keep canonical work even before its topology exists; retain the other admission rules. */
export function makeQueueRecordingCheck(topologyCheck: (sessionRef: string) => boolean): (sessionRef: string) => boolean {
  return sessionRef => parseSessionName(sessionRef).kind === "canonical" || topologyCheck(sessionRef);
}
