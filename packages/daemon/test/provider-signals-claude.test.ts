import { describe, it, expect } from "vitest";
import { claudeStatuslineSignals } from "../src/domain/provider/provider-signals.js";

// Slice-04 (OPR.0.5.0.4) — Claude statusline lane normalization (§2 Claude lane + the
// 2026-07-31 RESEARCH verdict). Proof item 6: the statusline sidecar's rate_limits object
// (Pro/Max five-hour + seven-day windows) becomes provider_statusline rows; the ABSENT cases
// (before the first API response when no cache exists yet) become EXPLICIT unknown rows with
// unknownReason — never silent zeros, never missing rows. Option A is SEAT-keyed: Claude's
// statusline exposes no account identity, so accountRef/api-key/org are excluded.

const ASOF = "2026-08-03T12:00:00.000Z";
const RESET = "2026-08-03T17:00:00.000Z";

describe("claudeStatuslineSignals — Claude lane honesty", () => {
  it("a Claude seat before the first API response (no cache yet) yields a seat-keyed explicit unknown row", () => {
    const sigs = claudeStatuslineSignals({
      seatSession: "dev-impl@rig",
      cachePresent: false,
      asOf: ASOF,
    });
    expect(sigs).toHaveLength(1);
    expect(sigs[0].provider).toBe("claude");
    expect(sigs[0].seatSession).toBe("dev-impl@rig");
    expect(sigs[0].accountRef).toBeUndefined();
    expect(sigs[0].sourceClass).toBe("unknown");
    expect(sigs[0].authority).toBe("unknown");
    expect(sigs[0].unknownReason).toBeTruthy();
    expect(sigs[0].usedPercent).toBeUndefined();
    expect(sigs[0].automationUse).toBe("do_not_automate");
    expect(sigs[0].supportsNotification).toBe(false);
    expect(sigs[0].asOf).toBe(ASOF);
  });

  it("a Pro/Max statusline reading yields provider_statusline rows for five_hour + weekly (seven-day)", () => {
    const sigs = claudeStatuslineSignals({
      seatSession: "dev-impl@rig",
      cachePresent: true,
      reading: {
        five_hour: { usedPercent: 12, resetsAt: RESET },
        seven_day: { usedPercent: 0, resetsAt: RESET }, // genuine zero — must survive as 0
      },
      asOf: ASOF,
    });
    const fiveHour = sigs.find((s) => s.window === "five_hour");
    expect(fiveHour).toBeDefined();
    expect(fiveHour!.sourceClass).toBe("provider_statusline");
    expect(fiveHour!.authority).toBe("account_cross_device");
    expect(fiveHour!.seatSession).toBe("dev-impl@rig");
    expect(fiveHour!.accountRef).toBeUndefined();
    expect(fiveHour!.usedPercent).toBe(12);
    expect(fiveHour!.resetsAt).toBe(RESET);
    expect(fiveHour!.supportsNotification).toBe(false);
    expect(fiveHour!.automationUse).toBe("allow_switch_decision");
    // seven-day maps to the normalized "weekly" window; genuine 0 preserved as 0.
    const weekly = sigs.find((s) => s.window === "weekly");
    expect(weekly).toBeDefined();
    expect(weekly!.usedPercent).toBe(0);
  });

  it("a subscription with cache present but no windows degrades to an explicit unknown row", () => {
    const sigs = claudeStatuslineSignals({
      seatSession: "dev-impl@rig",
      cachePresent: true,
      reading: {},
      asOf: ASOF,
    });
    expect(sigs).toHaveLength(1);
    expect(sigs[0].sourceClass).toBe("unknown");
    expect(sigs[0].usedPercent).toBeUndefined();
    expect(sigs[0].automationUse).toBe("do_not_automate");
  });
});
