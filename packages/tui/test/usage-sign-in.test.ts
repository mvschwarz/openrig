// Slice 01 — the TUI account row shows the sign-in fact as served, and an unknown row's reason even with windows.
import { describe, expect, it } from "vitest";
import { allowanceLines } from "../src/usage/usage-model.js";

const ROW = {
  provider: "codex",
  identity: { accountId: "acct-1", workspaceId: null, limitId: "codex", email: "dev@example.test", planType: "plus", source: "account/rateLimits/read accountId" },
  seats: "unknown",
  windows: [{ window: "primary", durationMins: 300, usedPercent: 41, remainingPercent: 59, resetsAt: "R", observedAt: "O", level: "ok", freshness: "fresh" }],
  limitEvidence: null,
  latestFromSource: true,
  lastRefresh: { at: "O", outcome: "ok" },
  currentAvailability: "known",
};
const text = (row: Record<string, unknown>) => allowanceLines(row).map((l) => l.text);

describe("TUI account row: the sign-in fact", () => {
  it("prints after availability, with evidence and time", () => {
    expect(text({ ...ROW, signIn: { state: "usable", evidence: "the refresh's rate-limit read was answered", at: "O" } }))
      .toEqual(expect.arrayContaining(["    current availability: known", "    sign-in: usable (the refresh's rate-limit read was answered; as of O)"]));
  });
  it("an unavailable row prints it too, in plain words", () => {
    expect(text({ provider: "claude", identity: null, windows: [], unavailableReason: "no Claude seat yet",
      signIn: { state: "needs_sign_in", evidence: "claude auth status reports no login", at: "T" } }))
      .toContain("    sign-in: needs sign-in (claude auth status reports no login; as of T)");
  });
  it("a row without the field (an older daemon) prints no sign-in line", () => {
    expect(text(ROW).some((l) => l.includes("sign-in"))).toBe(false);
  });
  it("CHANGED: a row with windows and unknown availability prints its reason", () => {
    expect(text({ ...ROW, currentAvailability: "unknown", unavailableReason: "the reason" })).toContain("    the reason");
  });
});
