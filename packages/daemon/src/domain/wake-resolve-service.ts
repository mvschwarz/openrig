import { resolveWakeTarget, type WakeSessionRow, type WakeResolution } from "./wake-resolver.js";

export const WAKE_SESSIONS_SQL = `SELECT s.id AS id, s.session_name AS sessionName, s.resume_token AS resumeToken,
                    n.runtime AS runtime, s.created_at AS createdAt
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
