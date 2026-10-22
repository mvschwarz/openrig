import type Database from "better-sqlite3";

/** Read an existing fresh-launch effect, fenced by the current generation.
 * Older builds could leave a detached predecessor unsuperseded. The owning
 * event still names the deliberate successor: timestamps and newest-row
 * guesses are unnecessary. No history or native identity is rewritten here.
 */
export function readFreshOccupantRelations(db: Database.Database, rigId: string): Record<string, string | null> {
  const generations = db.prepare(`
    SELECT t.node_id AS nodeId, t.generation_uuid AS generation
    FROM occupant_tenures t JOIN nodes n ON n.id = t.node_id
    WHERE n.rig_id = ? AND t.generation_ordinal =
      (SELECT MAX(t2.generation_ordinal) FROM occupant_tenures t2 WHERE t2.node_id = t.node_id)
  `).all(rigId) as Array<{ nodeId: string; generation: string }>;
  const current = new Map(generations.map((row) => [row.nodeId, row.generation]));
  // Through the rig's nodes into each node's fresh launches (idx_events_node_type_seq): by rig_id alone SQLite reads every
  // event the rig ever recorded to test its type. node_id is the event's own nodeId (EventBus), and a node outside this rig
  // has no current tenure here, so the rows used are the same.
  const events = db.prepare(`
    SELECT e.payload AS payload FROM nodes n
    CROSS JOIN events e ON e.node_id = n.id AND e.type = 'seat.fresh_launched'
    WHERE n.rig_id = ? AND e.rig_id = ?
    ORDER BY e.seq
  `).all(rigId, rigId) as Array<{ payload: string }>;
  const relation: Record<string, string | null> = {};
  for (const row of events) {
    const event = JSON.parse(row.payload) as Record<string, unknown>;
    if (typeof event.nodeId !== "string" || !current.has(event.nodeId)
      || event.newGeneration !== current.get(event.nodeId)) continue;
    const id = typeof event.sessionId === "string" && event.sessionId ? event.sessionId : null;
    if (Object.prototype.hasOwnProperty.call(relation, event.nodeId) && relation[event.nodeId] !== id) {
      relation[event.nodeId] = null; // contradictory current effects remain unavailable
    } else relation[event.nodeId] = id;
  }
  return relation;
}

/** The event seq of each node's current-generation fresh launch that reached
 * ready. A restore attempt that started before it describes the retired
 * occupant, not the current one. A launch that needed attention, failed,
 * belongs to an older generation or contradicts another gives no fence, so
 * the recorded restore outcome stands.
 */
export function readReadyFreshLaunchFences(db: Database.Database, rigId?: string): Map<string, number> {
  // Indexed: from each node's current tenure into that node's fresh-launch events
  // (idx_events_node_type_seq), not every event of the type. `rig ps` runs this on every call.
  // CROSS JOIN keeps events the inner table: left to choose, SQLite scans every event first.
  const events = db.prepare(`
    SELECT e.seq AS seq, e.payload AS payload, t.node_id AS nodeId, t.generation_uuid AS generation
    FROM occupant_tenures t
    JOIN nodes n ON n.id = t.node_id
    CROSS JOIN events e ON e.node_id = t.node_id AND e.type = 'seat.fresh_launched'
    WHERE t.generation_ordinal =
      (SELECT MAX(t2.generation_ordinal) FROM occupant_tenures t2 WHERE t2.node_id = t.node_id)${rigId ? " AND n.rig_id = ?" : ""}
    ORDER BY e.seq
  `).all(...(rigId ? [rigId] : [])) as Array<{ seq: number; payload: string; nodeId: string; generation: string }>;
  const launches = new Map<string, { seq: number; sessionId: string | null; ready: boolean } | null>();
  for (const row of events) {
    let event: Record<string, unknown>;
    try { event = JSON.parse(row.payload) as Record<string, unknown>; } catch { continue; }
    if (event.nodeId !== row.nodeId || event.newGeneration !== row.generation) continue;
    const sessionId = typeof event.sessionId === "string" && event.sessionId ? event.sessionId : null;
    const prior = launches.get(row.nodeId);
    if (prior === null) continue;
    launches.set(row.nodeId, prior && prior.sessionId !== sessionId
      ? null // contradictory current effects give no fence
      : { seq: row.seq, sessionId, ready: event.status === "ready" && (prior?.ready ?? true) });
  }
  const fences = new Map<string, number>();
  for (const [nodeId, launch] of launches) {
    if (launch?.sessionId && launch.ready) fences.set(nodeId, launch.seq);
  }
  return fences;
}
