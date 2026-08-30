// OPR.0.5.6.1 — the §5 delivery rules engine.
//
// The stored per-human A–D register plus availability decide exactly ONE
// connector-agnostic outcome per message: interrupt · notify · digest · log.
// The engine CONSUMES the F-8 owner-notification level enum and the two config
// dials (one vocabulary, one classifier — S14's); it mints no transport
// literals and no parallel classification. Dispatch stays in the gateway;
// availability TIMING (the away deferral) is engine-owned and rides the
// watchdog substrate (AM-F1: no third timer engine).
//
// THE REGISTER MAPPING, documented once (mini-req 1, A1.5 vocabulary):
//   A — interrupt-always   → interrupt
//   B — hub-exceptions     → notify   (escalation lifts to interrupt)
//   C — worker-parked      → digest, 4-hour window
//   D — milestones         → digest, daily window
//   log is never a register cell: it is the outcome for messages below the
//   minimum-level-that-posts dial (F-8 RECORD) — durable row only, no post.
//
// AVAILABILITY (net-new enum; legacy `away: true` reads as availability=away
// ONLY when the availability field is whole-field-absent — the D1 convention):
//   available — no modulation
//   focus     — mutes NORMAL interrupts to notify; escalation still interrupts
//   away      — mutes normal mentions; a non-A escalation becomes ONE deferred
//               interrupt at T+30 to the SAME human (M1 §5 preset, AM-F3);
//               register A stays immediate (interrupt-ALWAYS is the stronger word)
//   off       — F-7 VERBATIM: off is respected; escalation never overrides it.
//               Delivery is never suppressed (F-8): the post lands unmentioned,
//               and the single-human termination is recorded loud.
//
// The delivery-state table (AM-F4 — one definition site, defined AGAINST the
// S14 receipt stamps; the engine never re-spells a transport verdict):
//   queued    = the row exists, no delivery transition yet
//   posted    = the S14 posted receipt transition is on the row
//   notified  = posted AND the decision was interrupt (mention delivered)
//   replied   = an inbound reply row references the conversation
//   transport-failed = the S14 transport-failed transition (there is NO
//                      second spelling; "post-failed" does not exist)
//   `seen` DOES NOT EXIST and cannot be represented (design §6: unprovable).

import type { OwnerNotificationLevel } from "../queue-transition-log.js";
import { ownerNotificationLevelAtLeast } from "../queue-transition-log.js";
import { WAKE_ESCALATION_TAG } from "../queue-wake-ladder.js";

export const DELIVERY_OUTCOMES = ["interrupt", "notify", "digest", "log"] as const;
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

export const AVAILABILITY_MODES = ["available", "focus", "away", "off"] as const;
export type AvailabilityMode = (typeof AVAILABILITY_MODES)[number];

export const AWAY_ESCALATION_DEFER_MINUTES = 30;

export const DIGEST_WINDOWS = { C: "4h", D: "daily" } as const;

/** The single-human termination record (A1.1): an escalation on an away/off
 *  human terminates at the recorded floor — who, availability,
 *  no-fallback-available, and the ruled delivery outcome. The multi-human
 *  fallback edge is 0.5.7; this seam takes it without vocabulary change. */
export interface DeliveryTermination {
  who: string;
  availability: AvailabilityMode;
  noFallbackAvailable: true;
  deliveryOutcome: DeliveryOutcome;
}

export interface DeliveryDecision {
  outcome: DeliveryOutcome;
  /** Mention iff interrupt — quiet cells never mention, by construction. */
  mention: boolean;
  digestWindow?: "4h" | "daily";
  /** Present only for the deferred away-escalation interrupt (fires once at T+N). */
  deferMinutes?: number;
  termination?: DeliveryTermination;
}

export interface DeliveryDecisionInput {
  level: OwnerNotificationLevel | null;
  escalation: boolean;
  human: {
    entityId: string;
    deliveryClass: "A" | "B" | "C" | "D";
    availability: AvailabilityMode;
  };
  dials: {
    minimumLevelThatPosts: OwnerNotificationLevel;
    minimumLevelThatInterrupts: OwnerNotificationLevel;
  };
}

/** Whole-field-absent legacy inference (the D1 convention): `away: true` reads
 *  as availability=away ONLY when the availability field is absent. A present
 *  availability is the authority; conflicts are refused at fragment validation,
 *  never silently resolved here. */
export function resolveAvailability(prefs: { availability?: string; away?: boolean }): AvailabilityMode {
  if (prefs.availability !== undefined) return prefs.availability as AvailabilityMode;
  if (prefs.away === true) return "away";
  return "available";
}

/** Escalation-class derivation — ONE predicate (the ladder's aggregate tag or
 *  an explicit escalation tag), never a prose read. */
export function isEscalationClass(tags: readonly string[] | null | undefined): boolean {
  if (!tags) return false;
  return tags.includes(WAKE_ESCALATION_TAG) || tags.includes("escalation");
}

export function decideDelivery(input: DeliveryDecisionInput): DeliveryDecision {
  const level = input.level ?? "RECORD";
  const { deliveryClass, availability, entityId } = input.human;

  // Below the posts dial: durable only — the row always lands; nothing posts.
  if (!ownerNotificationLevelAtLeast(level, input.dials.minimumLevelThatPosts)) {
    return { outcome: "log", mention: false };
  }

  // The register base, lifted by escalation (escalation never digests).
  let outcome: DeliveryOutcome =
    input.escalation ? "interrupt"
    : deliveryClass === "A" ? "interrupt"
    : deliveryClass === "B" ? "notify"
    : "digest";

  // The interrupts dial (the S14 semantic, preserved through the engine):
  // an interrupt below the dial demotes to notify — posting eligibility and
  // interruption eligibility are separate axes (F-8).
  if (outcome === "interrupt" && !ownerNotificationLevelAtLeast(level, input.dials.minimumLevelThatInterrupts)) {
    outcome = "notify";
  }

  let deferMinutes: number | undefined;
  let termination: DeliveryTermination | undefined;

  switch (availability) {
    case "available":
      break;
    case "focus":
      // focus mutes NORMAL interrupts; escalation still interrupts (design §3).
      // Register A is the exception in BOTH quiet modes (focus here, away
      // below): interrupt-ALWAYS is the human's own stronger word.
      if (outcome === "interrupt" && !input.escalation && deliveryClass !== "A") outcome = "notify";
      break;
    case "away":
      if (input.escalation) {
        // Single-human floor recorded for every away/off escalation (A1.1).
        if (outcome === "interrupt" && deliveryClass !== "A") {
          // M1 §5 preset generalized (documented uniform non-A rule): ONE
          // deferred interrupt at T+30 to the SAME human, never
          // immediate-plus-deferred (AM-F3).
          deferMinutes = AWAY_ESCALATION_DEFER_MINUTES;
        }
        termination = { who: entityId, availability, noFallbackAvailable: true, deliveryOutcome: outcome };
      } else if (outcome === "interrupt" && deliveryClass !== "A") {
        outcome = "notify"; // design §3: away normal = post, no mention
      }
      break;
    case "off":
      // F-7 VERBATIM: off is respected — escalation never overrides it. An off
      // that interrupts is not an off. Delivery is never suppressed (F-8): the
      // durable row, the post, and the receipt all still land, unmentioned.
      if (outcome === "interrupt") outcome = "notify";
      if (input.escalation) {
        termination = { who: entityId, availability, noFallbackAvailable: true, deliveryOutcome: outcome };
      }
      break;
  }

  // mention iff interrupt — for a DEFERRED interrupt the mention rides the
  // T+30 fire, not the sweep (the delivery layer holds the post; the flag
  // describes the decided loudness, one rule for every cell).
  return {
    outcome,
    mention: outcome === "interrupt",
    ...(outcome === "digest" ? { digestWindow: DIGEST_WINDOWS[deliveryClass as "C" | "D"] ?? "4h" } : {}),
    ...(deferMinutes !== undefined ? { deferMinutes } : {}),
    ...(termination !== undefined ? { termination } : {}),
  };
}

/** The termination transition literal — engine-owned, one definition site.
 *  (A row-side record; readers match the prefix, same discipline as the
 *  ladder's marker vocabulary.) */
export const DELIVERY_TERMINATION_PREFIX = "delivery-termination:";

export function formatDeliveryTermination(t: DeliveryTermination, notificationKey: string): string {
  return [
    DELIVERY_TERMINATION_PREFIX,
    `who=${t.who}`,
    `availability=${t.availability}`,
    "no-fallback-available",
    `outcome=${t.deliveryOutcome}`,
    `notification_key=${notificationKey}`,
  ].join(" ");
}
