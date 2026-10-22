import type Database from "better-sqlite3";
import { defaultResolveOrchestrator, resolveSessionNodeId } from "./queue-owner.js";

export const ESCALATION_HOP_TAG = "escalation-route:one-hop";
export interface EscalationOwner {
  owner: string | null;
  outcome: "parent" | "none" | "routed" | "unavailable" | "ambiguous" | "self" | "cycle" | "unknown";
  reason: string;
}
interface Seat { id: string; address: string; session_name: string | null; status: string | null }
interface Arc { source_id: string; target_id: string | null; target_ref: string | null; kind: string }

/** Resolve one delivery hop. Graph inspection is topology-only, including stopped seats;
 * runtime status is consulted only after proving the selected target isn't in a cycle. */
export function resolveEscalationOwner(db: Database.Database, session: string, acceptsDestination?: (destination: string) => boolean): EscalationOwner {
  const source = resolveSessionNodeId(db, session);
  const parent = defaultResolveOrchestrator(db, session);
  if (!source) return { owner: parent, outcome: "none", reason: "no recorded source topology" };
  // A declared parent without a session still wins over a newly declared fallback.
  if (db.prepare("SELECT 1 FROM edges WHERE target_id=? AND kind='delegates_to'").get(source)) {
    return { owner: parent, outcome: "parent", reason: "declared delegation parent retained" };
  }
  if (!db.prepare("SELECT 1 FROM edges WHERE source_id=? AND kind='escalates_to'").get(source)) {
    return { owner: null, outcome: "none", reason: "no escalation destination declared" };
  }
  // Curated/older test stores without the new column have no deferred targets.
  const hasRefs = (db.prepare("PRAGMA table_info(edges)").all() as Array<{ name: string }>).some(c => c.name === "target_ref");
  const arcs = db.prepare(`SELECT source_id, target_id, ${hasRefs ? "target_ref" : "NULL AS target_ref"}, kind
    FROM edges WHERE kind IN ('delegates_to','escalates_to')`).all() as Arc[];
  const declared = arcs.filter(a => a.kind === "escalates_to" && a.source_id === source);
  if (!declared.length) return { owner: null, outcome: "none", reason: "no escalation destination declared" };
  const fail = (outcome: EscalationOwner["outcome"], detail: string): EscalationOwner =>
    ({ owner: null, outcome, reason: `escalates_to ${outcome}: ${detail}; existing fallback retained` });
  if (declared.length !== 1) return fail("ambiguous", "multiple declared destinations");
  const seats = db.prepare(`SELECT n.id, replace(n.logical_id,'.','-') || '@' || r.name AS address,
      s.session_name, s.status FROM nodes n JOIN rigs r ON r.id=n.rig_id
      LEFT JOIN sessions s ON s.id=(SELECT id FROM sessions WHERE node_id=n.id ORDER BY id DESC LIMIT 1)
      WHERE r.archived_at IS NULL`).all() as Seat[];
  const endpoints = (arc: Arc): Seat[] => arc.target_ref
    ? (() => {
      const exact = seats.filter(s => s.session_name === arc.target_ref);
      return exact.length ? exact : seats.filter(s => s.address === arc.target_ref);
    })()
    : seats.filter(s => s.id === arc.target_id);
  const targets = endpoints(declared[0]!);
  if (!targets.length) return fail("unavailable", "destination absent from this daemon's active topology");
  if (targets.length !== 1) return fail("ambiguous", "destination names more than one seat");
  const target = targets[0]!;
  if (target.id === source) return fail("self", "destination is the source seat");

  const visiting = new Set<string>([source]);
  const visited = new Set<string>();
  let unknown = false;
  const cyclic = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const parents = arcs.filter(a => a.kind === "delegates_to" && a.target_id === id);
    const next = parents.length ? parents.map(a => seats.filter(s => s.id === a.source_id))
      : arcs.filter(a => a.kind === "escalates_to" && a.source_id === id).map(endpoints);
    if (next.length > 1) unknown = true;
    for (const matches of next) {
      if (matches.length !== 1) unknown = true;
      for (const seat of matches) if (cyclic(seat.id)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if (cyclic(target.id)) return fail("cycle", "declared escalation/delegation topology contains a cycle");
  if (unknown) return fail("unknown", "cycle check includes an unresolved or ambiguous declared endpoint");
  if (!target.session_name || !["running", "idle"].includes(target.status ?? "")) {
    return fail("unavailable", "destination has no running recorded session");
  }
  if (acceptsDestination && !acceptsDestination(target.session_name)) {
    return fail("unavailable", "destination not admitted by queue");
  }
  return { owner: target.session_name, outcome: "routed", reason: `escalates_to routed: ${session} -> ${target.session_name} (one hop)` };
}
