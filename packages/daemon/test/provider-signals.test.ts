import { describe, it, expect } from "vitest";
import {
  codexRateLimitSignals,
  deriveUsageLimitPools,
  reactiveEventSignal,
} from "../src/domain/provider/provider-signals.js";

// Slice-04 (OPR.0.5.0.4) — signals[] normalization, the §1 contract's honesty rules
// (packet 3ffa3c22 IMPLEMENTATION-PRD §1/§2 + the 2026-07-31 RESEARCH verdict).
// The load-bearing negatives (BR-2 seed): an absent/unsupported reading is an EXPLICIT
// `unknown` row, never a silent zero and never a missing row.

const ASOF = "2026-08-03T12:00:00.000Z";
const RESET = "2026-08-03T17:00:00.000Z";

describe("codexRateLimitSignals — normalization honesty", () => {
  it("feature-probe negative yields exactly one explicit unknown row (not a silent zero, not empty)", () => {
    const sigs = codexRateLimitSignals({
      accountRef: "acct-1",
      probe: { supported: false },
      asOf: ASOF,
    });
    expect(sigs).toHaveLength(1);
    const s = sigs[0];
    expect(s.provider).toBe("codex");
    expect(s.accountRef).toBe("acct-1");
    expect(s.sourceClass).toBe("unknown");
    expect(s.authority).toBe("unknown");
    expect(s.unknownReason).toBeTruthy();
    // The silent-zero trap: usedPercent must be ABSENT, never defaulted to 0.
    expect(s.usedPercent).toBeUndefined();
    expect(s.resetsAt).toBeUndefined();
    // BR-2: an unknown signal must never be automatable.
    expect(s.automationUse).toBe("do_not_automate");
    // App-server absent → no notification transport.
    expect(s.supportsNotification).toBe(false);
    expect(s.asOf).toBe(ASOF);
  });

  it("preserves a GENUINE zero from a real read (0 is real data, distinct from omitted-unknown)", () => {
    const sigs = codexRateLimitSignals({
      accountRef: "acct-1",
      probe: { supported: true },
      reading: {
        // usedPercent 0 is a REAL reading (fresh window, nothing used) — must survive as 0.
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: RESET },
        secondary: { usedPercent: 88, windowDurationMins: 10080, resetsAt: RESET },
      },
      asOf: ASOF,
    });
    const primary = sigs.find((s) => s.window === "primary");
    expect(primary).toBeDefined();
    expect(primary!.sourceClass).toBe("provider_structured_read");
    expect(primary!.authority).toBe("account_cross_device");
    // Genuine zero preserved (NOT omitted, NOT treated as unknown).
    expect(primary!.usedPercent).toBe(0);
    expect(primary!.resetsAt).toBe(RESET);
    expect(primary!.windowDurationMins).toBe(300);
    // Codex app-server carries updated-notifications; automatable structured read.
    expect(primary!.supportsNotification).toBe(true);
    expect(primary!.automationUse).toBe("allow_switch_decision");
    // Provider-native secondary window preserved, not collapsed.
    const secondary = sigs.find((s) => s.window === "secondary");
    expect(secondary).toBeDefined();
    expect(secondary!.usedPercent).toBe(88);
  });

  it("supported-but-empty read degrades to unknown DATA but keeps KNOWN transport capability", () => {
    const sigs = codexRateLimitSignals({
      accountRef: "acct-1",
      probe: { supported: true },
      reading: {},
      asOf: ASOF,
    });
    expect(sigs).toHaveLength(1);
    expect(sigs[0].sourceClass).toBe("unknown");
    // Still no fabricated zero.
    expect(sigs[0].usedPercent).toBeUndefined();
    expect(sigs[0].automationUse).toBe("do_not_automate");
    // The app-server IS present, so account/rateLimits/updated capability is KNOWN true —
    // unknown data must not erase known transport capability.
    expect(sigs[0].supportsNotification).toBe(true);
  });
});

describe("S16 usage-limit pool derivation", () => {
  const NOW = new Date("2026-08-28T12:00:00.000Z");

  it("groups every Claude seat under one local limit and keeps the latest stated reset", () => {
    const pools = deriveUsageLimitPools({
      now: NOW,
      fallbackSeconds: 300,
      bindings: [],
      signals: [
        {
          provider: "claude",
          seatSession: "dev-a@rig",
          sourceClass: "provider_statusline",
          authority: "account_cross_device",
          window: "five_hour",
          usedPercent: 100,
          resetsAt: "2026-08-28T13:00:00.000Z",
          asOf: "2026-08-28T11:59:00.000Z",
          staleAfter: "2026-08-28T12:10:00.000Z",
          supportsNotification: false,
          automationUse: "allow_switch_decision",
        },
        {
          provider: "claude",
          seatSession: "dev-b@rig",
          sourceClass: "provider_statusline",
          authority: "account_cross_device",
          window: "five_hour",
          usedPercent: 72,
          resetsAt: "2026-08-28T13:00:00.000Z",
          asOf: "2026-08-28T11:59:00.000Z",
          staleAfter: "2026-08-28T12:10:00.000Z",
          supportsNotification: false,
          automationUse: "allow_switch_decision",
        },
      ],
    });

    expect(pools).toEqual([
      {
        poolKey: "claude:local",
        provider: "claude",
        seatSessions: ["dev-a@rig", "dev-b@rig"],
        expiresAt: "2026-08-28T13:00:00.000Z",
        source: "provider-reset",
      },
    ]);
  });

  it("uses the signal as-of plus the config fallback for a fresh Codex at-limit event with no reset", () => {
    const pools = deriveUsageLimitPools({
      now: NOW,
      fallbackSeconds: 300,
      bindings: [
        {
          accountId: "acct-codex-1",
          seatSession: "dev-c@rig",
          rigName: "rig",
          boundAt: "2026-08-28T08:00:00.000Z",
          bindingSource: "fixture",
          anomalies: [],
        },
      ],
      signals: [reactiveEventSignal({
        provider: "codex",
        accountRef: "acct-codex-1",
        kind: "at_limit",
        asOf: "2026-08-28T11:59:00.000Z",
        staleAfter: "2026-08-28T12:10:00.000Z",
      })],
    });

    expect(pools).toEqual([
      {
        poolKey: "codex:acct-codex-1",
        provider: "codex",
        seatSessions: ["dev-c@rig"],
        expiresAt: "2026-08-28T12:04:00.000Z",
        source: "config-fallback",
      },
    ]);
  });

  it("never guesses usage-limit from unknown, advisory, stale, or already-expired evidence", () => {
    const pools = deriveUsageLimitPools({
      now: NOW,
      fallbackSeconds: 300,
      bindings: [],
      signals: [
        {
          provider: "claude",
          seatSession: "unknown@rig",
          sourceClass: "unknown",
          authority: "unknown",
          asOf: "2026-08-28T11:59:00.000Z",
          staleAfter: "2026-08-28T12:10:00.000Z",
          unknownReason: "no_reading",
          automationUse: "do_not_automate",
        },
        {
          provider: "claude",
          seatSession: "stale@rig",
          sourceClass: "provider_statusline",
          authority: "account_cross_device",
          usedPercent: 100,
          resetsAt: "2026-08-28T13:00:00.000Z",
          asOf: "2026-08-28T11:00:00.000Z",
          staleAfter: "2026-08-28T11:30:00.000Z",
          automationUse: "allow_switch_decision",
        },
      ],
    });

    expect(pools).toEqual([]);
  });
});
