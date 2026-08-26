// OPR.0.5.5.19 A7 — THE PARKED QUERY, the flagship consumer (founder's one-command ask):
// "are we parked?" at rig level, "is this seat parked?" at seat level. PARKED is a
// DERIVED DIAGNOSIS (the taxonomy's rule — computed at read time, never stored):
// (activity = idle-at-prompt OR needs-input pending) × (open obligations exist).
//
// THE JOIN LIVES HERE, not in SeatActivityService — the oracle's non-inference contract
// holds; this module receives an obligation READER and never writes queue state.
//
// AM-3 (verdict 1229a4b7): parked inherits BOTH inputs' error terms, and the obligation
// face has measured dishonesty modes (stale blockedOn surviving closure, bare-scope
// false absences, limit truncation). So the query NAMES its obligation scope, guards the
// limit with a returned-count-under-limit check, and returns CONFIDENCE FOR BOTH INPUTS
// — a false NOT-PARKED from a missed obligation is the founder's undetected-park class
// rebuilt one level up; this output makes that failure visible rather than possible.
//
// S19 A7 RED: unwired.

import type { ArbitratedSeatState, NeedsInput } from "./activity-taxonomy.js";

/** One open obligation row from the queue's obligation face. HELD rows (state=blocked —
 *  the deliberate queue-level hold with an owner and a resolution path) are the
 *  vocabulary's NOT-parked case and are surfaced separately, never counted as
 *  park-driving. */
export interface ObligationRow {
  qitemId: string;
  state: "pending" | "in-progress" | "blocked";
  summary?: string | null;
}

export interface ObligationRead {
  /** The rows the reader returned (bounded by `limit`). */
  rows: ObligationRow[];
  /** The bound the reader applied — the guard input. */
  limit: number;
}

export interface ParkedQueryDeps {
  getSeatState: (seatNodeId: string) => ArbitratedSeatState | null;
  /** The obligation face, scoped destination + open-state; the query never widens or
   *  narrows this silently — the scope string in the result names exactly what ran. */
  listOpenObligations: (destinationSession: string, limit: number) => ObligationRead;
}

export interface SeatParkedDiagnosis {
  seatNodeId: string;
  sessionName: string;
  /** true / false, or "indeterminate" when an input cannot support the verdict. */
  parked: boolean | "indeterminate";
  reason: string;
  activity: {
    value: string;
    needsInput: NeedsInput;
    decidedBy: string | null;
    confidence: "oracle" | "unknown";
  };
  obligations: {
    /** The EXACT scope that ran — named, so a false absence is auditable. */
    scope: string;
    openCount: number;
    heldCount: number;
    /** false when returned == limit: the count may be truncated (never silently). */
    complete: boolean;
    limit: number;
    items: ObligationRow[];
  };
  confidence: { activity: "high" | "none"; obligations: "complete" | "truncation-possible" | "unavailable" };
}

export interface RigParkedDiagnosis {
  parked: boolean | "indeterminate";
  reason: string;
  seats: SeatParkedDiagnosis[];
}

export const PARKED_OBLIGATION_LIMIT = 500;

export function diagnoseSeatParked(
  _deps: ParkedQueryDeps,
  _seat: { seatNodeId: string; sessionName: string },
): SeatParkedDiagnosis {
  throw new Error("not implemented (S19 A7 RED)");
}

export function diagnoseRigParked(
  _deps: ParkedQueryDeps,
  _seats: Array<{ seatNodeId: string; sessionName: string }>,
): RigParkedDiagnosis {
  throw new Error("not implemented (S19 A7 RED)");
}
