import { describe, it, expect } from "vitest";
import { reactiveEventSignal } from "../src/domain/provider/provider-signals.js";
import { signalEligibleForAutomation } from "../src/domain/provider/provider-policy.js";

// Slice-04 (OPR.0.5.0.4) — the reactive lane (packet 3ffa3c22 §2). At-limit errors / stream
// failures / stop-error events are consumed IMMEDIATELY as sourceClass=provider_event,
// authority=reactive_error — EXHAUSTION evidence, not a remaining meter (so no usedPercent).
// An at-limit event is a real automation trigger; stream/stop errors are advisory context.
// The rows must flow honestly through the BR-2 predicate.

const NOW = "2026-08-03T12:00:00.000Z";
const FRESH = "2026-08-03T12:00:30.000Z"; // short freshness window after NOW

describe("reactiveEventSignal — reactive lane", () => {
  it("an at-limit event is a provider_event/reactive_error row with no fabricated meter", () => {
    const s = reactiveEventSignal({
      provider: "codex",
      accountRef: "acct-1",
      kind: "at_limit",
      asOf: NOW,
      staleAfter: FRESH,
    });
    expect(s.provider).toBe("codex");
    expect(s.sourceClass).toBe("provider_event");
    expect(s.authority).toBe("reactive_error");
    expect(s.usedPercent).toBeUndefined(); // exhaustion evidence, not a remaining meter
    // A generic reactive event does not establish transport capability — must not fabricate it.
    expect(s.supportsNotification).toBeUndefined();
    expect(s.automationUse).toBe("allow_switch_decision");
    expect(s.asOf).toBe(NOW);
  });

  it("stream-failure and stop-error are advisory_only (context, not proven exhaustion)", () => {
    for (const kind of ["stream_failure", "stop_error"] as const) {
      const s = reactiveEventSignal({ provider: "claude", accountRef: "c1", kind, asOf: NOW, staleAfter: FRESH });
      expect(s.sourceClass).toBe("provider_event");
      expect(s.authority).toBe("reactive_error");
      expect(s.automationUse).toBe("advisory_only");
      expect(s.usedPercent).toBeUndefined();
      expect(s.supportsNotification).toBeUndefined();
    }
  });

  it("a fresh at-limit event IS eligible through the BR-2 predicate", () => {
    const s = reactiveEventSignal({ provider: "codex", accountRef: "a1", kind: "at_limit", asOf: NOW, staleAfter: FRESH });
    expect(signalEligibleForAutomation(s, NOW).eligible).toBe(true);
  });

  it("stream-failure AND stop-error events are REFUSED by BR-2 (advisory, not allow_switch_decision)", () => {
    for (const kind of ["stream_failure", "stop_error"] as const) {
      const s = reactiveEventSignal({ provider: "codex", accountRef: "a1", kind, asOf: NOW, staleAfter: FRESH });
      const r = signalEligibleForAutomation(s, NOW);
      expect(r.eligible).toBe(false);
      expect(r.refusals).toContain("not_allow_switch_decision");
    }
  });
});
