// Slice-04 S-A (OPR.0.5.0.4, founder re-center A2) — HOST-LEVEL USAGE ROLLUP.
// Aggregates the seat-sourced C3 (Claude statusline) rows + C4 (Codex reactive)
// signals into ONE honest state row per (host, provider):
//   ok | nearing | limited (until resets_at when known) | explicit_unknown.
// THREE BINDING HONESTY CONDITIONS (PM):
//   (i)  host==account is a DEPLOYMENT INVARIANT, provenance-labeled as such —
//        rollup keys are (host, provider) ONLY; no account id is ever emitted;
//   (ii) conflicting seat windows on one host = FIRST-CLASS ANOMALY + explicit-
//        unknown host state, never a silent merge;
//   (iii) usage-limit granularity rides ONLY what the C3 rows already carry.

import { describe, it, expect } from "vitest";
import {
  rollupHostUsage,
  NEARING_THRESHOLD_PERCENT,
  CONFLICTING_RESETS_EPSILON_MS,
  type HostUsageRow,
} from "../src/domain/provider/host-usage-rollup.js";
import { collectFourBlockReadModel } from "../src/domain/provider/provider-collect.js";
import type { ProviderSignal } from "../src/domain/provider/provider-types.js";

const NOW = "2026-08-05T00:00:00.000Z";
const RESETS = "2026-08-05T03:00:00.000Z";

function claudeRow(seat: string, usedPercent: number | undefined, over: Partial<ProviderSignal> = {}): ProviderSignal {
  return {
    provider: "claude",
    seatSession: seat,
    sourceClass: usedPercent === undefined ? "unknown" : "provider_statusline",
    authority: usedPercent === undefined ? "unknown" : "account_cross_device",
    ...(usedPercent === undefined ? { unknownReason: "statusline_cache_absent" } : { usedPercent, window: "five_hour" as const, resetsAt: RESETS }),
    asOf: NOW,
    automationUse: usedPercent === undefined ? "do_not_automate" : "allow_switch_decision",
    ...over,
  };
}

function codexEventRow(over: Partial<ProviderSignal> = {}): ProviderSignal {
  return {
    provider: "codex",
    accountRef: "acct-profile-a", // input MAY carry it; the rollup must never emit it
    sourceClass: "provider_event",
    authority: "reactive_error",
    asOf: NOW,
    staleAfter: "2026-08-05T00:05:00.000Z",
    automationUse: "allow_switch_decision", // at_limit exhaustion
    ...over,
  };
}

function rowFor(rows: HostUsageRow[], provider: string): HostUsageRow {
  const r = rows.find((x) => x.provider === provider);
  expect(r, `expected a ${provider} rollup row`).toBeDefined();
  return r!;
}

describe("S-A host-level usage rollup (pure)", () => {
  it("claude OK: agreeing seat windows aggregate to ONE (host,provider) row with C3-carried granularity + the deployment-invariant provenance label", () => {
    const rows = rollupHostUsage({
      signals: [claudeRow("dev-a@r", 30), claudeRow("dev-b@r", 33)],
      codexProfilesPresent: false,
      now: NOW,
    });
    expect(rows).toHaveLength(1);
    const r = rowFor(rows, "claude");
    expect(r.host).toBe("local");
    expect(r.state).toBe("ok");
    expect(r.windows.length).toBeGreaterThan(0);
    expect(r.windows.every((w) => w.window === "five_hour")).toBe(true);
    expect(r.evidenceSeats.sort()).toEqual(["dev-a@r", "dev-b@r"]);
    expect(r.provenance.basis).toBe("one_account_per_host_deployment_invariant");
    expect(r.provenance.note).toMatch(/deployment invariant/i);
    expect(r.provenance.note).toMatch(/not.*account classification/i);
    expect(r.anomalies).toEqual([]);
    expect(r.asOf).toBe(NOW);
  });

  it("claude NEARING at the threshold; LIMITED at 100 with resets_at carried from the exhausted window", () => {
    const nearing = rollupHostUsage({
      signals: [claudeRow("a@r", NEARING_THRESHOLD_PERCENT)],
      codexProfilesPresent: false,
      now: NOW,
    });
    expect(rowFor(nearing, "claude").state).toBe("nearing");

    const limited = rollupHostUsage({
      signals: [claudeRow("a@r", 100)],
      codexProfilesPresent: false,
      now: NOW,
    });
    const lr = rowFor(limited, "claude");
    expect(lr.state).toBe("limited");
    expect(lr.resetsAt).toBe(RESETS);
  });

  it("(ii) CONFLICTING seat windows = first-class anomaly + explicit_unknown — NEVER a silent merge", () => {
    const otherReset = "2026-08-05T06:30:00.000Z"; // a different account's schedule
    const rows = rollupHostUsage({
      signals: [
        claudeRow("a@r", 30),
        claudeRow("b@r", 90, { resetsAt: otherReset }),
      ],
      codexProfilesPresent: false,
      now: NOW,
    });
    const r = rowFor(rows, "claude");
    expect(r.state).toBe("explicit_unknown");
    expect(r.unknownReason).toMatch(/conflict/i);
    expect(r.anomalies).toHaveLength(1);
    const a = r.anomalies[0]!;
    expect(a.kind).toBe("conflicting_seat_windows");
    expect(a.window).toBe("five_hour");
    expect(a.seats.sort()).toEqual(["a@r", "b@r"]);
    expect(a.evidence).toContain(RESETS);
    expect(a.evidence).toContain(otherReset);
    // the conflicting facts stay VISIBLE (no merged/averaged number is fabricated)
    expect(r.windows).toHaveLength(2);
  });

  it("(ii) tolerance: resets_at sampling skew INSIDE the epsilon does not conflict", () => {
    // ABSOLUTE anchor (ruled epsilon = 120s): 119s spread. Deliberately NOT computed from the
    // imported constant — an eps-relative fixture tracks constant drift and can never catch it.
    const skewed = new Date(Date.parse(RESETS) + 119_000).toISOString();
    const rows = rollupHostUsage({
      signals: [claudeRow("a@r", 30), claudeRow("b@r", 31, { resetsAt: skewed })],
      codexProfilesPresent: false,
      now: NOW,
    });
    const r = rowFor(rows, "claude");
    expect(r.state).toBe("ok");
    expect(r.anomalies).toEqual([]);
  });

  it("(ii) the ruled epsilon VALUE is pinned (drift in either direction is a deliberate re-rule, not an accident)", () => {
    expect(CONFLICTING_RESETS_EPSILON_MS).toBe(120_000);
  });

  it("(ii) boundary, just-OUTSIDE: eps+1s divergence IS a conflict — first-class anomaly + explicit_unknown (guard 6b2e84d3: the epsilon is falsifiable from above)", () => {
    // ABSOLUTE anchor: 121s spread — one second OUTSIDE the ruled 120s epsilon. Under any
    // upward constant drift (the guard's 30x probe) this stops conflicting and FAILS here.
    const skewed = new Date(Date.parse(RESETS) + 121_000).toISOString();
    const rows = rollupHostUsage({
      signals: [claudeRow("a@r", 30), claudeRow("b@r", 31, { resetsAt: skewed })],
      codexProfilesPresent: false,
      now: NOW,
    });
    const r = rowFor(rows, "claude");
    expect(r.state).toBe("explicit_unknown");
    expect(r.anomalies).toHaveLength(1);
    expect(r.anomalies[0]!.kind).toBe("conflicting_seat_windows");
    expect(r.anomalies[0]!.seats.sort()).toEqual(["a@r", "b@r"]);
  });

  it("claude all-unknown seat rows → explicit_unknown carrying the unknownReason (never ok-by-absence)", () => {
    const rows = rollupHostUsage({
      signals: [claudeRow("a@r", undefined), claudeRow("b@r", undefined)],
      codexProfilesPresent: false,
      now: NOW,
    });
    const r = rowFor(rows, "claude");
    expect(r.state).toBe("explicit_unknown");
    expect(r.unknownReason).toBeTruthy();
  });

  it("codex: a FRESH at-limit event → limited (exhaustion evidence; resets_at absent is honest)", () => {
    const rows = rollupHostUsage({
      signals: [codexEventRow()],
      codexProfilesPresent: true,
      now: NOW,
    });
    const r = rowFor(rows, "codex");
    expect(r.state).toBe("limited");
    expect(r.resetsAt).toBeUndefined();
  });

  it("codex: an advisory-only event (stream/stop error) is NOT usage evidence → explicit_unknown, not limited and not ok", () => {
    const rows = rollupHostUsage({
      signals: [codexEventRow({ automationUse: "advisory_only" })],
      codexProfilesPresent: true,
      now: NOW,
    });
    expect(rowFor(rows, "codex").state).toBe("explicit_unknown");
  });

  it("codex: a STALE at-limit event never drives limited (BR-2 class; inclusive expiry)", () => {
    const rows = rollupHostUsage({
      signals: [codexEventRow({ staleAfter: NOW })], // now >= staleAfter → stale
      codexProfilesPresent: true,
      now: NOW,
    });
    expect(rowFor(rows, "codex").state).toBe("explicit_unknown");
  });

  it("codex present (profiles on disk) with ZERO signals → an explicit_unknown row naming the missing meter — the blindside is surfaced, not omitted", () => {
    const rows = rollupHostUsage({ signals: [], codexProfilesPresent: true, now: NOW });
    const r = rowFor(rows, "codex");
    expect(r.state).toBe("explicit_unknown");
    expect(r.unknownReason).toMatch(/meter|no usage/i);
  });

  it("(i) NO account identity ever appears in any rollup row — even when input signals carry accountRef", () => {
    const rows = rollupHostUsage({
      signals: [codexEventRow(), claudeRow("a@r", 42, { accountRef: "acct-claude-forged" })],
      codexProfilesPresent: true,
      now: NOW,
    });
    const json = JSON.stringify(rows);
    expect(json).not.toContain("accountRef");
    expect(json).not.toContain("accountId");
    expect(json).not.toContain("acct-profile-a");
    expect(json).not.toContain("acct-claude-forged");
  });

  it("providers with no deployment presence emit NO row (no claude seats, no codex profiles)", () => {
    expect(rollupHostUsage({ signals: [], codexProfilesPresent: false, now: NOW })).toEqual([]);
  });
});

describe("S-A composition — hostUsage rides the read model (additive block)", () => {
  it("collectFourBlockReadModel emits hostUsage aggregated from the SAME signals it collected", () => {
    const model = collectFourBlockReadModel({
      readCodexAuth: () => ({ profiles: ["p1"], seats: [] }),
      listSeats: () => [],
      collectSignals: () => [codexEventRow()],
      now: () => NOW,
    });
    expect(model.hostUsage).toBeDefined();
    const codex = model.hostUsage!.find((r) => r.provider === "codex");
    expect(codex?.state).toBe("limited");
    expect(JSON.stringify(model.hostUsage)).not.toContain("accountRef");
  });
});
