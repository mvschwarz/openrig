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

export interface ParkWakeDiagnosis {
  kind: "watchdog" | "timer" | "blocker";
  ref: string;
  live: boolean;
  phase?: "armed" | "fired";
  deliveryStatus?: string | null;
  unconsumed: boolean;
}

export interface HeldObligation extends ObligationRow {
  state: "blocked";
  wake: ParkWakeDiagnosis | null;
  healthy: boolean;
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
  /** Optional only for pre-073 fixtures. Missing is honestly wakeless. */
  getParkWake?: (qitemId: string) => unknown;
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
    unhealthyHeldCount: number;
    /** false when returned == limit: the count may be truncated (never silently). */
    complete: boolean;
    limit: number;
    items: ObligationRow[];
    held: HeldObligation[];
  };
  confidence: { activity: "high" | "none"; obligations: "complete" | "truncation-possible" | "unavailable" };
}

export interface RigParkedDiagnosis {
  parked: boolean | "indeterminate";
  reason: string;
  seats: SeatParkedDiagnosis[];
}

export const PARKED_OBLIGATION_LIMIT = 500;

const HELD_REMEDY = "Remedy: attach a live watchdog id, arm an atomic timer, or name a live blocker qitem. The queue is a conveyor: work with a workspace home that is deferred/not-imminent belongs in its workspace mission/slice, not in HELD.";

function parseWake(value: unknown): ParkWakeDiagnosis | null {
  if (!value || typeof value !== "object") return null;
  const wake = value as Record<string, unknown>;
  if (!(["watchdog", "timer", "blocker"] as unknown[]).includes(wake.kind)) return null;
  if (typeof wake.ref !== "string" || typeof wake.live !== "boolean") return null;
  return {
    kind: wake.kind as ParkWakeDiagnosis["kind"],
    ref: wake.ref,
    live: wake.live,
    phase: wake.phase === "armed" || wake.phase === "fired" ? wake.phase : undefined,
    deliveryStatus: typeof wake.deliveryStatus === "string" ? wake.deliveryStatus : null,
    unconsumed: wake.unconsumed === true,
  };
}

export function diagnoseSeatParked(
  deps: ParkedQueryDeps,
  seat: { seatNodeId: string; sessionName: string },
): SeatParkedDiagnosis {
  const state = deps.getSeatState(seat.seatNodeId);
  const scope = `destination=${seat.sessionName} state=pending,in-progress,blocked limit=${PARKED_OBLIGATION_LIMIT}`;
  const read = deps.listOpenObligations(seat.sessionName, PARKED_OBLIGATION_LIMIT);
  const held: HeldObligation[] = read.rows.filter((r) => r.state === "blocked").map((row) => {
    const wake = parseWake(deps.getParkWake?.(row.qitemId));
    return { ...row, state: "blocked", wake, healthy: wake?.live === true && !wake.unconsumed };
  });
  const unhealthyHeld = held.filter((row) => !row.healthy);
  const open = read.rows.filter((r) => r.state !== "blocked");
  const complete = read.rows.length < read.limit;

  const obligations: SeatParkedDiagnosis["obligations"] = {
    scope,
    openCount: open.length,
    heldCount: held.length,
    unhealthyHeldCount: unhealthyHeld.length,
    complete,
    limit: read.limit,
    items: open,
    held,
  };

  const activityKnown = state !== null && state.activity !== "unknown";
  const activity: SeatParkedDiagnosis["activity"] = {
    value: state?.activity ?? "unknown",
    needsInput: state?.needsInput ?? { count: 0, reason: null },
    decidedBy: state?.decidedBy ?? null,
    confidence: activityKnown ? "oracle" : "unknown",
  };
  const confidence: SeatParkedDiagnosis["confidence"] = {
    activity: activityKnown ? "high" : "none",
    obligations: complete ? "complete" : "truncation-possible",
  };

  // The diagnosis: (idle-at-prompt OR needs-input pending) × open obligations.
  // Activity-unknown can never support a verdict — INDETERMINATE, never a guessed
  // NOT-PARKED (the founder's undetected-park class rebuilt one level up).
  // Truncation only UNDERCOUNTS obligations, so a positive verdict stands under it.
  if (!activityKnown) {
    return {
      seatNodeId: seat.seatNodeId,
      sessionName: seat.sessionName,
      parked: "indeterminate",
      reason: `activity is unknown for ${seat.sessionName} — the oracle cannot support a parked verdict (obligation face read anyway: ${open.length} open, ${held.length} held)`,
      activity,
      obligations,
      confidence,
    };
  }

  const stopped = state.activity === "idle-at-prompt" || state.needsInput.count > 0;
  const parked = stopped && (open.length > 0 || unhealthyHeld.length > 0);
  const unconsumed = unhealthyHeld.filter((row) => row.wake?.unconsumed);
  const reason = parked
    ? state.needsInput.count > 0
      ? `needs-input (${state.needsInput.reason ?? "unanswered block"}) with ${open.length} open obligation(s) and ${unhealthyHeld.length} unhealthy HELD row(s) — ${unconsumed.length > 0 ? `${unconsumed.length} wake(s) fired but remain unconsumed. ` : ""}${HELD_REMEDY}`
      : `idle-at-prompt with ${open.length} open obligation(s) and ${unhealthyHeld.length} unhealthy HELD row(s) — ${unconsumed.length > 0 ? `${unconsumed.length} wake(s) fired but remain unconsumed. ` : ""}${HELD_REMEDY}`
    : stopped
      ? held.length > 0
        ? `stopped with ${held.length} HELD row(s), all healthy with a live wake — not parked`
        : "stopped but the board is clean"
      : `working — not parked`;

  return {
    seatNodeId: seat.seatNodeId,
    sessionName: seat.sessionName,
    parked,
    reason,
    activity,
    obligations,
    confidence,
  };
}

export function diagnoseRigParked(
  deps: ParkedQueryDeps,
  seats: Array<{ seatNodeId: string; sessionName: string }>,
): RigParkedDiagnosis {
  const diagnoses = seats.map((s) => diagnoseSeatParked(deps, s));
  const parkedSeats = diagnoses.filter((d) => d.parked === true);
  const indeterminate = diagnoses.filter((d) => d.parked === "indeterminate");
  if (parkedSeats.length > 0) {
    return {
      parked: true,
      reason: `${parkedSeats.length} seat(s) parked: ${parkedSeats.map((d) => d.sessionName).join(", ")}`,
      seats: diagnoses,
    };
  }
  if (indeterminate.length > 0) {
    // An unreadable seat can hide a park — the rig verdict must not claim all-clear.
    return {
      parked: "indeterminate",
      reason: `no seat is provably parked, but ${indeterminate.length} seat(s) are indeterminate (${indeterminate.map((d) => d.seatNodeId).join(", ")}) — not an all-clear`,
      seats: diagnoses,
    };
  }
  return { parked: false, reason: "no seat is parked", seats: diagnoses };
}
