import type Database from "better-sqlite3";
import type { RigWithRelations } from "./types.js";

export interface CurrentStateRehydrateEligibility {
  ok: boolean;
  blockers: string[];
}

/**
 * Determines whether current persisted DB state is sufficient to synthesize a
 * restore snapshot after volatile runtime state (tmux) disappeared.
 *
 * This is intentionally conservative. It does not claim provider continuity by
 * itself; it only says the existing restore orchestrator has enough persisted
 * input to attempt a normal restore from an on-demand snapshot.
 */
export function assessCurrentStateRehydrateEligibility(
  db: Database.Database,
  rig: RigWithRelations,
): CurrentStateRehydrateEligibility {
  const blockers: string[] = [];

  if (rig.nodes.length === 0) {
    blockers.push("rig has no nodes to rehydrate");
  }

  const sessions = db.prepare(
    `SELECT node_id, resume_token
       FROM sessions
       WHERE node_id IN (${rig.nodes.map(() => "?").join(",") || "NULL"})
         AND status NOT IN ('superseded', 'exited')
       ORDER BY id DESC`
  ).all(...rig.nodes.map((node) => node.id)) as Array<{ node_id: string; resume_token: string | null }>;

  if (rig.nodes.length > 0 && sessions.length === 0) {
    blockers.push("rig has no persisted sessions to rehydrate");
  }

  const sessionByNode = new Map<string, Array<{ resume_token: string | null }>>();
  for (const session of sessions) {
    const rows = sessionByNode.get(session.node_id) ?? [];
    rows.push(session);
    sessionByNode.set(session.node_id, rows);
  }

  for (const node of rig.nodes) {
    const runtime = node.runtime ?? "";
    const isAgentRuntime = runtime.length > 0 && runtime !== "terminal";
    const hasStartupContext = !!db.prepare(
      "SELECT 1 FROM node_startup_context WHERE node_id = ? LIMIT 1"
    ).get(node.id);
    const hasResumeToken = (sessionByNode.get(node.id) ?? []).some((session) =>
      typeof session.resume_token === "string" && session.resume_token.length > 0
    );

    if (node.podId && !hasStartupContext) {
      blockers.push(`node ${node.logicalId} is pod-aware but has no persisted startup context`);
      continue;
    }

    if (isAgentRuntime && !hasStartupContext && !hasResumeToken) {
      blockers.push(`node ${node.logicalId} has runtime ${runtime} but no startup context or resume token`);
    }
  }

  return { ok: blockers.length === 0, blockers };
}
