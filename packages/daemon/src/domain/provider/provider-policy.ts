// Slice-04 (OPR.0.5.0.4) — BR-2, the no-fire policy predicate (packet 3ffa3c22 §2 + BR-2).
// A PURE predicate (no side effects, no action execution, no orchestration): it only decides
// whether one signal is eligible to trigger an automated switch. Automation NEVER fires on a
// signal that is unknown, not allow_switch_decision, or not provably fresh. Every failing
// condition contributes an explicit, fail-visible refusal reason.

import type { ProviderSignal } from "./provider-types.js";

export type AutomationRefusal =
  | "sourceClass_unknown"
  | "authority_unknown"
  | "not_allow_switch_decision"
  | "no_freshness_bound"
  | "unparsable_freshness_bound"
  | "stale";

export interface AutomationEligibility {
  eligible: boolean;
  refusals: AutomationRefusal[];
}

/**
 * BR-2 eligibility. Eligible ONLY when the signal is known (source + authority), explicitly
 * `allow_switch_decision`, and provably fresh. Fail-closed on freshness: a missing `staleAfter`
 * or an unparsable one is ineligible (NaN must never compare as fresh). Expiry is INCLUSIVE:
 * `now >= staleAfter` is stale. An unparsable `now` also cannot prove freshness → stale.
 */
export function signalEligibleForAutomation(
  signal: ProviderSignal,
  nowIso: string,
): AutomationEligibility {
  const refusals: AutomationRefusal[] = [];

  if (signal.sourceClass === "unknown") refusals.push("sourceClass_unknown");
  if (signal.authority === "unknown") refusals.push("authority_unknown");
  if (signal.automationUse !== "allow_switch_decision") refusals.push("not_allow_switch_decision");

  if (signal.staleAfter === undefined) {
    refusals.push("no_freshness_bound");
  } else {
    const staleMs = Date.parse(signal.staleAfter);
    if (Number.isNaN(staleMs)) {
      refusals.push("unparsable_freshness_bound");
    } else {
      const nowMs = Date.parse(nowIso);
      // Fail-closed: an unparsable `now`, or reaching/passing the bound, is stale.
      if (Number.isNaN(nowMs) || nowMs >= staleMs) refusals.push("stale");
    }
  }

  return { eligible: refusals.length === 0, refusals };
}
