import { describe, it, expect } from "vitest";
import { signalEligibleForAutomation } from "../src/domain/provider/provider-policy.js";
import type { ProviderSignal } from "../src/domain/provider/provider-types.js";

// Slice-04 (OPR.0.5.0.4) — BR-2, the load-bearing negative (packet 3ffa3c22 §2 policy + BR-2):
// automation NEVER fires on a signal that is unknown, stale, or not allow_switch_decision. The
// RED here is the discriminating one — a predicate that cannot REFUSE proves nothing, so every
// disqualifier must yield eligible:false with an explicit, fail-visible refusal reason.

const NOW = "2026-08-03T12:00:00.000Z";
const FUTURE = "2026-08-03T12:05:00.000Z"; // after NOW → fresh
const PAST = "2026-08-03T11:55:00.000Z"; // before NOW → stale

// A genuine, automatable structured read: known source/authority, allow_switch_decision, fresh.
const AUTOMATABLE: ProviderSignal = {
  provider: "codex",
  accountRef: "acct-1",
  sourceClass: "provider_structured_read",
  authority: "account_cross_device",
  window: "primary",
  usedPercent: 95,
  resetsAt: FUTURE,
  asOf: NOW,
  staleAfter: FUTURE,
  supportsNotification: true,
  automationUse: "allow_switch_decision",
};

describe("signalEligibleForAutomation — BR-2 no-fire", () => {
  it("a fresh, known, allow_switch_decision structured read IS eligible (the predicate can say yes)", () => {
    const r = signalEligibleForAutomation(AUTOMATABLE, NOW);
    expect(r.eligible).toBe(true);
    expect(r.refusals).toEqual([]);
  });

  it("REFUSES an unknown signal (sourceClass/authority unknown, do_not_automate)", () => {
    const unknown: ProviderSignal = {
      provider: "codex",
      accountRef: "acct-1",
      sourceClass: "unknown",
      authority: "unknown",
      asOf: NOW,
      staleAfter: FUTURE,
      unknownReason: "codex_app_server_unavailable",
      supportsNotification: false,
      automationUse: "do_not_automate",
    };
    const r = signalEligibleForAutomation(unknown, NOW);
    expect(r.eligible).toBe(false);
    expect(r.refusals).toContain("sourceClass_unknown");
    expect(r.refusals).toContain("authority_unknown");
    expect(r.refusals).toContain("not_allow_switch_decision");
  });

  it("REFUSES a stale signal (now past staleAfter) even when otherwise automatable", () => {
    const r = signalEligibleForAutomation({ ...AUTOMATABLE, staleAfter: PAST }, NOW);
    expect(r.eligible).toBe(false);
    expect(r.refusals).toContain("stale");
  });

  it("REFUSES an advisory_only signal (automationUse != allow_switch_decision)", () => {
    const r = signalEligibleForAutomation({ ...AUTOMATABLE, automationUse: "advisory_only" }, NOW);
    expect(r.eligible).toBe(false);
    expect(r.refusals).toContain("not_allow_switch_decision");
  });

  it("REFUSES a signal with no freshness bound (cannot confirm fresh → err safe)", () => {
    const noStale = { ...AUTOMATABLE };
    delete (noStale as { staleAfter?: string }).staleAfter;
    const r = signalEligibleForAutomation(noStale, NOW);
    expect(r.eligible).toBe(false);
    expect(r.refusals).toContain("no_freshness_bound");
  });

  it("REFUSES an unparsable staleAfter fail-closed (NaN must never compare fresh)", () => {
    const r = signalEligibleForAutomation({ ...AUTOMATABLE, staleAfter: "not-a-timestamp" }, NOW);
    expect(r.eligible).toBe(false);
    expect(r.refusals).toContain("unparsable_freshness_bound");
    // must NOT be silently treated as fresh/stale-by-accident
    expect(r.refusals).not.toContain("stale");
  });

  it("treats the exact expiry boundary now == staleAfter as STALE (now >= staleAfter)", () => {
    const r = signalEligibleForAutomation({ ...AUTOMATABLE, staleAfter: NOW }, NOW);
    expect(r.eligible).toBe(false);
    expect(r.refusals).toContain("stale");
  });
});
