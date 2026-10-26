import { resolveWakeTarget, type WakeSessionRow, type WakeResolution } from "./wake-resolver.js";

// Unknown-runtime claims can acquire a supported resume identity through a later hook.
// Keep any explicit node runtime authoritative; only NULL falls back to that record.
export const WAKE_SESSIONS_SQL = `SELECT s.id AS id, s.session_name AS sessionName, s.resume_token AS resumeToken,
                    COALESCE(n.runtime, CASE s.resume_type
                      WHEN 'claude_id' THEN 'claude-code'
                      WHEN 'claude_name' THEN 'claude-code'
                      WHEN 'codex_id' THEN 'codex'
                    END) AS runtime, s.created_at AS createdAt
               FROM sessions s JOIN nodes n ON s.node_id = n.id
              WHERE s.session_name = ? ORDER BY s.id DESC`;

export interface WakeResolveServiceDeps {
  /** Return the seat's sessions rows NEWEST-FIRST (id DESC). Wired in startup to
   *  the sessions⋈nodes query; injectable for tests. */
  listSessionsBySeat: (seat: string) => WakeSessionRow[];
}

/**
 * L3b — thin service behind /api/wake-resolve: fetch the seat's sessions rows and
 * delegate to the pure resolveWakeTarget (ruling A — resolve on the stores that
 * exist, refuse-and-teach otherwise).
 */
export class WakeResolveService {
  private readonly deps: WakeResolveServiceDeps;

  constructor(deps: WakeResolveServiceDeps) {
    this.deps = deps;
  }

  resolve(seat: string, generation?: number): WakeResolution {
    const rows = this.deps.listSessionsBySeat(seat);
    return resolveWakeTarget(rows, { seat, generation });
  }
}
