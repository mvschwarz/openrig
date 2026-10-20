import { resolveCurrentSessionAddress } from "./session-registry.js";
import type Database from "better-sqlite3";

/** The durable session→node binding (the session-registry precedent: latest sessions row
 *  for the canonical name). Canonical session names (dash form, `review-r2@rig`) and node
 *  logical ids (dotted form, `review.r2`) are INDEPENDENT identities — the live fleet has
 *  zero cases where they match — so resolution NEVER string-converts between them. */
export function resolveSessionNodeId(db: Database.Database, session: string): string | null {
  const row = db
    .prepare("SELECT node_id FROM sessions WHERE session_name = ? ORDER BY id DESC LIMIT 1")
    .get(session) as { node_id: string } | undefined;
  return row?.node_id ?? resolveCurrentSessionAddress(db, session)?.nodeId ?? null;
}

/** Default orchestrator derivation: the destination's BOUND node → the source of its
 *  delegates_to edge → that parent node's CURRENT canonical session binding. A session
 *  outside the recorded topology, or a parent with no session binding, resolves to null
 *  (there is no orchestrator session to wake — never synthesize one). */
export function defaultResolveOrchestrator(db: Database.Database, session: string): string | null {
  const nodeId = resolveSessionNodeId(db, session);
  if (!nodeId) return null;
  const row = db
    .prepare(
      `SELECT s.session_name AS parentSession FROM edges e
         JOIN sessions s ON s.node_id = e.source_id
        WHERE e.target_id = ? AND e.kind = 'delegates_to'
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT 1`,
    )
    .get(nodeId) as { parentSession: string } | undefined;
  return row?.parentSession ?? null;
}

/** A rig's representative, the seat a person's message to "the rig" reaches: the rig's one
 *  delegation root, the node that delegates to others and that nothing delegates to, at its
 *  CURRENT canonical session binding. Null when the rig name is ambiguous or absent, when the rig
 *  has no such root or several, or when the root has no session; the caller falls back to its
 *  configured destination rather than guessing. */
export function resolveRigRepresentative(db: Database.Database, rigName: string): string | null {
  const rigs = db.prepare("SELECT id FROM rigs WHERE name = ?").all(rigName) as Array<{ id: string }>;
  if (rigs.length !== 1) return null;
  const roots = db
    .prepare(
      `SELECT n.id AS nodeId FROM nodes n
        WHERE n.rig_id = ?
          AND EXISTS (SELECT 1 FROM edges e WHERE e.source_id = n.id AND e.kind = 'delegates_to')
          AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.target_id = n.id AND e.kind = 'delegates_to')`,
    )
    .all(rigs[0]!.id) as Array<{ nodeId: string }>;
  if (roots.length !== 1) return null;
  const row = db
    .prepare("SELECT session_name FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1")
    .get(roots[0]!.nodeId) as { session_name: string } | undefined;
  return row?.session_name ?? null;
}
