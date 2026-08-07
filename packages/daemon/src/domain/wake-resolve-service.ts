import { resolveWakeTarget, type WakeSessionRow, type WakeResolution } from "./wake-resolver.js";

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
