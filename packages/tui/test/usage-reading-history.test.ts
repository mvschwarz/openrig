// Slice 01 — the TUI account row shows the reading history as served: a retained row's label, a window's
// expectation (planning only), the last observed exhaustion, the account link and an inactive account's profile.
import { describe, expect, it } from "vitest";
import { allowanceLines } from "../src/usage/usage-model.js";

const ROW = {
  provider: "codex",
  identity: { accountId: "acct-1", workspaceId: null, limitId: "codex", email: "dev@example.test", planType: "plus", source: "account/rateLimits/read accountId" },
  seats: "unknown",
  windows: [{ window: "primary", durationMins: 300, usedPercent: 100, remainingPercent: 0, resetsAt: "R", observedAt: "O", level: "unknown", levelReason: "reset passed at R; a new reading is needed", freshness: "stale", freshnessReason: "read at O, before the daemon restarted at S",
    expectation: { expectedFullSince: "R", note: "planning, not a reading" } }],
  limitEvidence: null,
  latestFromSource: false,
  retained: "before_restart",
  lastRefresh: null,
  currentAvailability: "unknown",
  accountHistory: "linked",
  lastObservedExhausted: { at: "E", window: "primary", evidence: "at the limit" },
  savedProfile: "not linked",
};
const text = (row: Record<string, unknown>) => allowanceLines(row).map((l) => l.text);

describe("TUI account row: reading history", () => {
  it("draws each served fact", () => {
    const lines = text(ROW);
    expect(lines[0]).toContain("[kept from before the daemon restarted; not a current reading]");
    expect(lines).toContain("      expected full since R, not yet observed (planning, not a reading)");
    expect(lines).toContain("    last observed exhausted at E (primary: at the limit)");
    expect(lines).toContain("    saved profile: not linked (OpenRig doesn't record which saved profile was active at this read)");
    expect(lines).not.toContain("    account history unknown");
  });
  it("an unlinked row says account history unknown; an older daemon's row draws none of these", () => {
    expect(text({ ...ROW, accountHistory: "unknown" })).toContain("    account history unknown");
    const { retained: _r, accountHistory: _a, lastObservedExhausted: _l, savedProfile: _s, ...older } = ROW;
    const lines = text({ ...older, windows: [{ ...ROW.windows[0], expectation: undefined }] }).join("\n");
    expect(lines).not.toMatch(/expected full|last observed exhausted|account history|saved profile|before the daemon restarted\]/);
  });
  it("a row with no identity yet still draws its history lines, before its sign-in line", () => {
    const lines = text({ provider: "claude", identity: null, windows: [], unavailableReason: "identity not read yet", accountHistory: "unknown",
      signIn: { state: "unknown", evidence: "no refresh since the daemon started at S", at: null } });
    expect(lines[1]).toBe("    account history unknown");
    expect(lines[2]).toMatch(/^    sign-in: unknown/);
  });
});
