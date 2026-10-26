import type Database from "better-sqlite3";
import type { RigWithRelations, Snapshot } from "./types.js";
import type { SnapshotRepository } from "./snapshot-repository.js";
import { snapshotMatchesCurrentOccupants } from "./rehydrate-eligibility.js";

/** The startup route's current, policy-ranked, structurally usable source.
 * History inspection may narrow occupant compatibility to its exact node;
 * ordinary startup keeps the original whole-rig check. */
export function currentRestoreSnapshot(db: Database.Database, snapshots: SnapshotRepository, rig: RigWithRelations, nodeId?: string): Snapshot | null {
  const snapshot = snapshots.findLatestRestoreUsable(rig.rig.id);
  // The older relation map is only read when the newer occupant map is absent.
  // Restore's structural snapshot check does not validate this legacy field;
  // reject a malformed authority before the node-scoped compatibility check
  // reaches resolveActiveOccupantRow. Startup without nodeId is unchanged.
  if (snapshot && nodeId && snapshot.data.activeOccupantsByNode === undefined) {
    const legacy: unknown = snapshot.data.activeSessionIdByNode;
    if (legacy !== undefined) {
      if (legacy === null || typeof legacy !== "object" || Array.isArray(legacy)) return null;
      if (Object.prototype.hasOwnProperty.call(legacy, nodeId)) {
        const relation = (legacy as Record<string, unknown>)[nodeId];
        if (relation !== null && (typeof relation !== "string" || !relation)) return null;
      }
    }
  }
  const checkedRig = nodeId ? { ...rig, nodes: rig.nodes.filter((node) => node.id === nodeId) } : rig;
  return snapshot && (!nodeId || checkedRig.nodes.length > 0) && snapshotMatchesCurrentOccupants(db, checkedRig, snapshot) ? snapshot : null;
}
