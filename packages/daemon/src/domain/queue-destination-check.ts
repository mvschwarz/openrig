// The existing topology-backed destination preflight, used when choosing a receiver.
// Recording canonical work is separate: absence must not prevent keeping the row.
import type Database from "better-sqlite3";
import { isHumanSeatSessionRef, parseSessionName } from "./session-name.js";
import { resolveExternal } from "./gateway/external-admission.js";
import type { LoadResult } from "./gateway/human-registry.js";
import { sharedChannelAddresses } from "./gateway/participants.js";
import { resolveSessionNodeId } from "./queue-owner.js";

// Human and external admission still use their registered-address rules.
// Other bare ids are admitted only as an active seat's current session name (#3799), when `db` is given.
export function makeTopologyDestinationCheck(deps: {
  findRigsByName: (name: string) => unknown[];
  loadHumanRegistry: () => LoadResult;
  /** Registered shared channels, which are `<id>@external` participants too (0.7.3). Default: the participant file. */
  sharedChannels?: () => ReadonlyArray<{ entityId: string; address: string }>;
  /** Admits a bare name that is an active seat's current session (#3799). Without it, bare names stay refused. */
  db?: Database.Database;
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
    if (parsed.kind !== "canonical") return deps.db !== undefined && isCurrentLocalSeatSession(deps.db, sessionRef);
    return deps.findRigsByName(parsed.rig).length > 0;
  };
}

/** A bare name (e.g. an adopted tmux selector such as `local-captain`, which rig detail reports as the
 *  representative) that is still its owner's current session: the shared resolver's node, in an active rig,
 *  whose latest session or current binding has this exact spelling. Once the resolver has picked the seat, the
 *  work is accepted: a stopped predecessor that keeps its binding beside its successor does not refuse it. */
export function isCurrentLocalSeatSession(db: Database.Database, sessionRef: string): boolean {
  const nodeId = resolveSessionNodeId(db, sessionRef);
  if (!nodeId) return false;
  return db.prepare(`SELECT 1 FROM nodes n JOIN rigs r ON r.id = n.rig_id
    WHERE n.id = ? AND r.archived_at IS NULL AND (
      EXISTS (SELECT 1 FROM bindings b WHERE b.node_id = n.id AND b.tmux_session = ?)
      OR (SELECT session_name FROM sessions WHERE node_id = n.id ORDER BY id DESC LIMIT 1) = ?)`)
    .get(nodeId, sessionRef, sessionRef) !== undefined;
}

/** Keep canonical work even before its topology exists; retain the other admission rules. */
export function makeQueueRecordingCheck(topologyCheck: (sessionRef: string) => boolean): (sessionRef: string) => boolean {
  return sessionRef => parseSessionName(sessionRef).kind === "canonical" || topologyCheck(sessionRef);
}
