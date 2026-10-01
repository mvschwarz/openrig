// S04 (OPR.0.5.5.4) — PICKUP RECEIPTS: derivation only. "A durable row nobody woke is
// indistinguishable from work in progress" — this module derives the distinction from facts
// the system already records (claimed_at, the transition log, last_heartbeat) against a
// config-keyed threshold. NO claimant-written receipt exists anywhere (a receipt a seat must
// remember to send would recreate the attention gap this kills), and NO sweep loop lives here
// (S02 owns the standing sweep; this module exports the INPUT contract it consumes).
//
// Working activity is positive liveness evidence, not proof of task progress.
// Otherwise the grace follows the latest meaningful queue change; an old note
// cannot keep the row working forever. Stalled-after-claim names this evidence
// without inferring idle/dead from age. Blocked remains parked; wake health is
// derived separately. A CLOSED row is terminal: the stall timer answers "is a
// claimant holding this obligation", and no obligation survives closure — a
// done item must never contradict its own waiting.state with stalled-after-claim.
// Legacy callers without timestamps retain count semantics.
// Queue-row last_heartbeat is formally superseded (2026-08-30, S24 F-14); readers remain
// null-tolerant. Wiring reopens only for the 0.5.7 mechanized-pull turn-end hook that knows the in-flight row,
// the first honest row-scoped writer. daemon-lifecycle-store.recordHeartbeat remains live and distinct.

import { SettingsStore } from "./user-settings/settings-store.js";

export const PICKUP_STALL_THRESHOLD_KEY = "queue.pickup_stall_threshold_minutes";
export const DEFAULT_PICKUP_STALL_THRESHOLD_MINUTES = 3;

export interface PickupReceipt {
  state: "unclaimed" | "working" | "stalled-after-claim" | "parked" | "terminal";
  /** Present iff stalled or terminal: the named evidence replacing the manual cross-surface join. */
  evidence?: string;
}

/** The closed states. The waiting view already reports every state outside
 *  pending/in-progress/blocked as "none (terminal obligation)"; the pickup
 *  receipt must not contradict it with a stall timer. `blocked` is NOT closed
 *  (it reads parked, and its wake health is derived separately). */
const CLOSED_PICKUP_STATES = ["done", "failed", "denied", "canceled", "handed-off"] as const;

/** Threshold, FRESH-READ per call (the terminal.status_bar precedent: a config flip applies
 *  to the next read, no restart). Fail-open to the default on any resolution error. */
export function resolvePickupThresholdMinutes(): number {
  try {
    const v = new SettingsStore().resolveOne(PICKUP_STALL_THRESHOLD_KEY).value;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_PICKUP_STALL_THRESHOLD_MINUTES;
  } catch {
    return DEFAULT_PICKUP_STALL_THRESHOLD_MINUTES;
  }
}

export interface PickupFacts {
  state: string;
  claimedAt: string | null | undefined;
  lastHeartbeat: string | null | undefined;
  /** Count of transitions strictly after the claim, excluding the claim's own transition. */
  postClaimMotionCount: number;
  lastMeaningfulAt?: string;
  activity?: string;
  needsInput?: number;
  now?: Date;
  thresholdMinutes?: number;
}

/** The ONE derivation rule — every projection surface (rowToItem, the pickup view lens, the
 *  S02 finding input) calls this same function, so the rule cannot drift between surfaces. */
export function derivePickup(facts: PickupFacts): PickupReceipt {
  if (facts.state === "blocked") return { state: "parked" };
  if ((CLOSED_PICKUP_STATES as readonly string[]).includes(facts.state)) {
    return { state: "terminal", evidence: `closed (${facts.state})` };
  }
  if (!facts.claimedAt) return { state: "unclaimed" };
  const now = facts.now ?? new Date();
  const claimedMs = Date.parse(facts.claimedAt);
  // Keep this null arm for the 0.5.7 mechanized-pull turn-end hook that knows the in-flight row;
  // it is the first honest row-scoped writer, and wiring reopens only in that slice.
  const heartbeatAfterClaim =
    !!facts.lastHeartbeat && Date.parse(facts.lastHeartbeat) > claimedMs;
  if (facts.activity === "working" && !facts.needsInput) return { state: "working" };
  // Legacy callers without a timestamp retain their historical count contract.
  if (facts.lastMeaningfulAt === undefined && (facts.postClaimMotionCount > 0 || heartbeatAfterClaim)) return { state: "working" };
  const thresholdMs = (facts.thresholdMinutes ?? resolvePickupThresholdMinutes()) * 60_000;
  const anchor = Math.max(claimedMs, Date.parse(facts.lastMeaningfulAt ?? facts.claimedAt), heartbeatAfterClaim ? Date.parse(facts.lastHeartbeat!) : claimedMs);
  const ageMs = now.getTime() - anchor;
  if (ageMs <= thresholdMs) return { state: "working" };
  const minutes = Math.floor(ageMs / 60_000);
  return {
    state: "stalled-after-claim",
    evidence: facts.lastMeaningfulAt === undefined
      ? `claimed ${minutes} min ago, zero substantive transitions since`
      : `no meaningful queue change for ${minutes} min; owner activity ${facts.activity ?? "unknown"} (queue age does not prove idle)`,
  };
}

/** S02 INPUT CONTRACT — the finding shape the standing sweep consumes (routed to the claimant
 *  first, then its orchestrator — the ROUTING is S02's; this is a pure library shape, no loop,
 *  no scheduler). Returns null for anything not stalled. */
export interface StalledPickupFinding {
  kind: "stalled-after-claim";
  /** The claimant (the row's destination — the seat that claimed and went quiet). */
  target: string;
  qitemId: string;
  evidence: string;
}

export function stalledPickupFinding(item: {
  qitemId: string;
  destinationSession?: string | null;
  pickup?: PickupReceipt;
}): StalledPickupFinding | null {
  if (item.pickup?.state !== "stalled-after-claim") return null;
  return {
    kind: "stalled-after-claim",
    target: item.destinationSession ?? "",
    qitemId: item.qitemId,
    evidence: item.pickup.evidence ?? "",
  };
}
