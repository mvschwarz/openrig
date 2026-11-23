// The existing topology-backed destination preflight, used when choosing a receiver.
// Recording canonical work is separate: absence must not prevent keeping the row.
import type Database from "better-sqlite3";
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

/** A seat's exact reported session name: one node of an active rig whose latest session or
 *  current binding has this spelling, e.g. an adopted bare tmux selector such as `local-captain`. */
export function isCurrentLocalSeatSession(db: Database.Database, sessionRef: string): boolean {
  const rows = db.prepare(`SELECT DISTINCT node_id FROM (
    SELECT s.node_id FROM sessions s JOIN nodes n ON n.id = s.node_id JOIN rigs r ON r.id = n.rig_id
      WHERE s.session_name = ? AND r.archived_at IS NULL
        AND s.id = (SELECT id FROM sessions WHERE node_id = s.node_id ORDER BY id DESC LIMIT 1)
    UNION ALL
    SELECT b.node_id FROM bindings b JOIN nodes n ON n.id = b.node_id JOIN rigs r ON r.id = n.rig_id
      WHERE b.tmux_session = ? AND r.archived_at IS NULL
  ) LIMIT 2`).all(sessionRef, sessionRef);
  return rows.length === 1;
}

/** Keep canonical work even before its topology exists, and work for a seat's exact current
 *  session name (the address rig detail reports as a representative); retain the other admission rules. */
export function makeQueueRecordingCheck(
  topologyCheck: (sessionRef: string) => boolean,
  db?: Database.Database,
): (sessionRef: string) => boolean {
  return sessionRef => parseSessionName(sessionRef).kind === "canonical" || topologyCheck(sessionRef)
    || (db !== undefined && isCurrentLocalSeatSession(db, sessionRef));
}
