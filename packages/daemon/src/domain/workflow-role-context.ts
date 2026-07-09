// OPR.0.4.6.FAC1 — the role-resolution CONTEXT builder: the impure
// half that materializes the pure policy's fact array from the shipped
// rig-scoped inventory projection + the SYNCHRONOUS work-enrichment.
//
// SYNC-ONLY BY CONSTRUCTION (arch Q1 = guard B4): this composes
// `getNodeInventory` (synchronous SQL projection — lifecycle already
// folds session status, restore outcome, and the identity-verdict
// down-rank) with `attachTerminalActivityAndWork` WITHOUT a
// SeatActivityService (so `terminalActive` stays undefined and only the
// sync pending-work map is computed). The ASYNC `attachAgentActivity`
// tmux-probe path is STRUCTURALLY absent — it cannot enter the
// synchronous close+create transaction (planner2's headline finding).
//
// LAZY BY CONSTRUCTION (guard B1): building a context performs ZERO
// reads — the snapshot materializes only when `candidatesForRig()` is
// invoked, which happens exclusively on the tier-3 resolution path
// (AFTER the frontier + absorption guards). Absorbed waiting-replays
// and terminal frontier rejections therefore perform zero
// role-resolution inventory reads; the commit-4 read-spy pins it.
//
// FRESH NAME→ID PER RESOLUTION (arch Q4): the bound rig persists as a
// NAME; each snapshot re-resolves name→id. A vanished rig returns
// null and the caller fails loud (`bound_rig_not_found` class) — WF-5
// catches the failed instance.

import type Database from "better-sqlite3";
import {
  attachTerminalActivityAndWork,
  deriveCanonicalFromEntry,
  getNodeInventory,
} from "./node-inventory.js";
import { selectRoleSeat, type RoleSeatCandidateFacts } from "./workflow-role-resolver.js";

export interface RoleResolutionContext {
  /** The instance's bound rig NAME (never null — an unbound instance
   *  builds no context at all; tier 3 simply does not exist for it). */
  boundRig: string;
  /**
   * Materialize the candidate-facts snapshot for the bound rig, NOW.
   * null = the bound rig no longer resolves by name (vanished mid-run).
   * Reads happen only when this is called (the guard-B1 laziness pin).
   */
  candidatesForRig: () => RoleSeatCandidateFacts[] | null;
}

/**
 * Build the (lazy) resolution context for a bound instance.
 * Returns undefined for unbound instances so call sites can thread
 * `instance.boundRig` straight through:
 *   `roleResolutionContext(db, instance.boundRig)`
 */
export function roleResolutionContext(
  db: Database.Database,
  boundRig: string | null | undefined,
): RoleResolutionContext | undefined {
  if (!boundRig) return undefined;
  return {
    boundRig,
    candidatesForRig: () => {
      const rig = db
        .prepare(`SELECT id FROM rigs WHERE name = ? ORDER BY created_at LIMIT 1`)
        .get(boundRig) as { id: string } | undefined;
      if (!rig) return null;
      const entries = attachTerminalActivityAndWork(getNodeInventory(db, rig.id), { db });
      return entries.map((e) => ({
        logicalId: e.logicalId,
        role: e.role,
        nodeKind: e.nodeKind,
        lifecycleState: e.lifecycleState,
        runtime: e.runtime,
        pendingWorkCount: e.pendingWorkCount ?? 0,
        coordinate: deriveCanonicalFromEntry(e),
        rawSessionName: e.canonicalSessionName,
      }));
    },
  };
}

/**
 * NON-THROWING capability pick (arch Q3 — the exception-routing
 * uniformity extension, bounded): resolve `role` on the bound rig or
 * return null. Exception routing must NEVER fail a close — a null here
 * falls through the router's chain to the human@host never-lost
 * fallback. Each exception item is a fresh decision at its own
 * detection moment (not a replay concern).
 */
export function tryResolveRoleByCapability(
  ctx: RoleResolutionContext | undefined,
  role: string,
  harness?: string,
): string | null {
  if (!ctx) return null;
  try {
    const candidates = ctx.candidatesForRig();
    if (!candidates) return null;
    return selectRoleSeat({ role, harness, candidates }).seat;
  } catch {
    return null;
  }
}

/**
 * The STRUCTURAL role-coverage probe (arch Q2 / guard B1): does ANY
 * seat on the bound rig declare `role`, at ANY lifecycle state?
 * Existence, not liveness — instantiate hard-fails only on ZERO
 * structural coverage (a typo'd/undeclared role), never on a
 * not-yet-running seat (factory rigs warm up; liveness is that step's
 * own projection-time concern).
 */
export function rigDeclaresRole(
  db: Database.Database,
  boundRig: string,
  role: string,
): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) as c FROM nodes n
         JOIN rigs r ON r.id = n.rig_id
        WHERE r.name = ? AND n.role = ?`,
    )
    .get(boundRig, role) as { c: number };
  return row.c > 0;
}

/**
 * OPR.0.4.6.FAC3 (FR-5): the structural MEMBER-EXISTS probe — does any
 * member of `rigName` derive the canonical coordinate `sessionRef`?
 *
 * Existence at ANY lifecycle state and ANY node kind (`rigDeclaresRole`'s
 * sibling discipline): a declared-but-not-yet-launched seat, or a
 * terminal member explicitly named as a preferred_target, is a
 * legitimate destination — liveness/kind is projection's business, not
 * this probe's. The compare is the DERIVED canonical coordinate
 * `{pod}-{member}@{rig}` via the same derivation tier-3 candidates use
 * (the FAC-1 Q5 one-string rule — a raw occupant-era session name never
 * participates). Sync SQL only; an unknown rig name returns false (the
 * caller's registered-rig skip runs first, so that case never reaches
 * an advisory here). MAY THROW on a partial-schema DB (the inventory
 * projection reads tables like `snapshots`) — the FR-5 sweep treats a
 * throw as cannot-vouch and skips (advisory-never-throw; VM-caught run-1).
 */
export function rigMemberExists(
  db: Database.Database,
  rigName: string,
  sessionRef: string,
): boolean {
  const rig = db
    .prepare(`SELECT id FROM rigs WHERE name = ? ORDER BY created_at LIMIT 1`)
    .get(rigName) as { id: string } | undefined;
  if (!rig) return false;
  return getNodeInventory(db, rig.id).some(
    (e) => deriveCanonicalFromEntry(e) === sessionRef,
  );
}
