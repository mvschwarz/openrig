// S04 (OPR.0.5.5.4) — PICKUP RECEIPTS: derivation only. "A durable row nobody woke is
// indistinguishable from work in progress" — this module derives the distinction from facts
// the system already records (claimed_at, the transition log, last_heartbeat) against a
// config-keyed threshold. NO claimant-written receipt exists anywhere (a receipt a seat must
// remember to send would recreate the attention gap this kills), and NO sweep loop lives here
// (S02 owns the standing sweep; this module exports the INPUT contract it consumes).
//
// The four honest states:
//   unclaimed           — never claimed;
//   working             — claimed AND (substantive post-claim motion OR still inside the
//                         threshold — the anti-noise direction: never prematurely stalled);
//   stalled-after-claim — claimed, past threshold, zero substantive motion; the evidence is
//                         NAMED ("claimed N min ago, zero substantive transitions since") so
//                         the old by-hand claimedAt/capture/transitions join retires;
//   parked              — state=blocked only. This projection knows nothing about wake
//                         health; `rig parked` carries the separate park-wake diagnosis.
//
// Substantive motion = any transition strictly after the claim other than the claim's own
// 'claimed' transition, or a heartbeat after the claim.
// Queue-row last_heartbeat is formally superseded (2026-08-30, S24 F-14); readers remain
// null-tolerant. Wiring reopens only for the 0.5.7 mechanized-pull turn-end hook that knows the in-flight row,
// the first honest row-scoped writer. daemon-lifecycle-store.recordHeartbeat remains live and distinct.

import { SettingsStore } from "./user-settings/settings-store.js";

export const PICKUP_STALL_THRESHOLD_KEY = "queue.pickup_stall_threshold_minutes";
export const DEFAULT_PICKUP_STALL_THRESHOLD_MINUTES = 3;

export interface PickupReceipt {
  state: "unclaimed" | "working" | "stalled-after-claim" | "parked";
  /** Present iff stalled: the named evidence replacing the manual cross-surface join. */
  evidence?: string;
}

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
  now?: Date;
  thresholdMinutes?: number;
}

/** The ONE derivation rule — every projection surface (rowToItem, the pickup view lens, the
 *  S02 finding input) calls this same function, so the rule cannot drift between surfaces. */
export function derivePickup(facts: PickupFacts): PickupReceipt {
  if (facts.state === "blocked") return { state: "parked" };
  if (!facts.claimedAt) return { state: "unclaimed" };
  const now = facts.now ?? new Date();
  const claimedMs = Date.parse(facts.claimedAt);
  // Keep this null arm for the 0.5.7 mechanized-pull turn-end hook that knows the in-flight row;
  // it is the first honest row-scoped writer, and wiring reopens only in that slice.
  const heartbeatAfterClaim =
    !!facts.lastHeartbeat && Date.parse(facts.lastHeartbeat) > claimedMs;
  if (facts.postClaimMotionCount > 0 || heartbeatAfterClaim) return { state: "working" };
  const thresholdMs = (facts.thresholdMinutes ?? resolvePickupThresholdMinutes()) * 60_000;
  const ageMs = now.getTime() - claimedMs;
  if (ageMs <= thresholdMs) return { state: "working" };
  const minutes = Math.floor(ageMs / 60_000);
  return {
    state: "stalled-after-claim",
    evidence: `claimed ${minutes} min ago, zero substantive transitions since`,
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
