/** A complete slice 18 move report: one seat moved with both kinds of evidence, one unconfirmed, one peer. */
export function moveReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    host: "build-box",
    home: "/home/ubuntu/.codex",
    from: "codex-1",
    to: "codex-2",
    reason: "codex-1 is at 92% of its weekly window and the build box works hardest",
    policy: { ref: "account-policy", version: "3" },
    readings: [
      { subject: "codex-1", basis: "observed", observedAt: "2026-10-23T12:00:00.000Z", summary: "weekly 92% used, resets 2026-10-25T00:00:00Z" },
      { subject: "codex-2", basis: "expected", observedAt: "2026-10-20T09:00:00.000Z", expectedFullSince: "2026-10-22T00:00:00.000Z", summary: "weekly reset passed; new reading needed" },
    ],
    seats: [
      { seat: "dev-impl@team", result: "moved", accountEvidence: { state: "matched", detail: "Account: two@example.com", at: "2026-10-23T12:10:00.000Z" }, toolTurn: { state: "observed", at: "2026-10-23T12:09:30.000Z" } },
      { seat: "dev-qa@team", result: "unconfirmed", missing: "no completed tool turn yet" },
    ],
    peers: [{ seat: "dev-lead@team", note: "not restarted; account unverified" }],
    ...overrides,
  };
}
