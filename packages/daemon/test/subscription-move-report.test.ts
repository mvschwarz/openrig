import { describe, expect, it } from "vitest";
import { checkMoveReport, findCredential, MOVE_REPORT_FENCE, readMoveReport, renderMoveReport } from "../src/domain/provider/subscription-move-report.js";
import { moveReport } from "./helpers/move-report-fixture.js";

// Slice 18 — the move report's checks are about what a report claims: a seat is `moved` only with matched account
// evidence and an observed tool turn; anything less has an honest unconfirmed or unknown form; an expectation stays
// labelled as one; and recognized credential formats never get in, or back out in an error.

const seat = (overrides: Record<string, unknown>) => moveReport({ seats: [{ seat: "dev-impl@team", ...overrides }] });
const errorsOf = (raw: unknown) => { const check = checkMoveReport(raw); return check.ok ? [] : check.errors; };

describe("subscription move report", () => {
  it("accepts a report whose seats are moved with both kinds of evidence, or unconfirmed with what's missing", () => {
    expect(checkMoveReport(moveReport()).ok).toBe(true);
    // A home switched with every seat left as a peer is still a move to report.
    expect(checkMoveReport(moveReport({ seats: [] })).ok).toBe(true);
    expect(checkMoveReport(moveReport({ policy: { none: true } })).ok).toBe(true);
  });

  it("refuses moved without matched account evidence and an observed tool turn, and names the honest form", () => {
    for (const evidence of [
      {},
      { accountEvidence: { state: "matched" } },
      { toolTurn: { state: "observed" } },
      { accountEvidence: { state: "not_observed" }, toolTurn: { state: "observed" } },
      { accountEvidence: { state: "matched" }, toolTurn: { state: "not_observed" } },
    ]) {
      const errors = errorsOf(seat({ result: "moved", ...evidence }));
      expect(errors).toEqual([expect.stringContaining("report it unconfirmed, with what's missing")]);
    }
    // The same seat reported honestly passes: an agent never has to claim a success it didn't see.
    expect(errorsOf(seat({ result: "unconfirmed", accountEvidence: { state: "matched" }, missing: "no completed tool turn yet" }))).toEqual([]);
    expect(errorsOf(seat({ result: "unknown", missing: "the verify check couldn't read the rollout" }))).toEqual([]);
  });

  it("refuses unconfirmed or unknown without what's missing, and an unknown result", () => {
    expect(errorsOf(seat({ result: "unconfirmed" }))).toEqual(["seats[0]: unconfirmed needs missing, what wasn't seen"]);
    expect(errorsOf(seat({ result: "unknown", missing: " " }))).toEqual(["seats[0]: unknown needs missing, what wasn't seen"]);
    expect(errorsOf(seat({ result: "probably", missing: "x" }))).toEqual(["seats[0].result must be moved, unconfirmed or unknown"]);
  });

  it("keeps an expectation labelled: it needs the reset it rests on, and an observed reading needs its time", () => {
    expect(errorsOf(moveReport({ readings: [{ subject: "codex-2", basis: "expected", summary: "reset passed" }] })))
      .toEqual(["readings[0]: an expected reading needs expectedFullSince, the reset it rests on"]);
    expect(errorsOf(moveReport({ readings: [{ subject: "codex-1", basis: "observed", summary: "92%" }] })))
      .toEqual(["readings[0]: an observed reading needs observedAt, when it was observed"]);
    // An unavailable reading is an honest basis, with no time to invent.
    expect(errorsOf(moveReport({ readings: [{ subject: "codex-3", basis: "unavailable", summary: "never read on this host" }] }))).toEqual([]);
    expect(errorsOf(moveReport({ readings: [] }))).toEqual([expect.stringContaining("readings must list at least one reading")]);
  });

  it("refuses recognized credential formats anywhere in a report, naming where and what, never the value", () => {
    const jwt = `eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.${"s".repeat(24)}`;
    const bearer = `Bearer ${"a".repeat(32)}`, key = "sk-proj-abcdefghijklmnopqrstu", gh = `ghp_${"b".repeat(36)}`;
    const cases: Array<[Record<string, unknown>, string, string, string]> = [
      [{ reason: `token ${jwt}` }, "report.reason", "JWT", jwt],
      [{ seats: [{ seat: "dev-impl@team", result: "unknown", missing: bearer }] }, "report.seats[0].missing", "bearer token", bearer],
      [{ readings: [{ subject: key, basis: "unavailable", summary: "x" }] }, "report.readings[0].subject", "API key", key],
      [{ peers: [{ seat: "x", note: gh }] }, "report.peers[0].note", "GitHub token", gh],
    ];
    for (const [overrides, path, kind, secret] of cases) {
      const errors = errorsOf(moveReport(overrides));
      expect(errors).toEqual([`${path} holds what looks like a ${kind}; a report holds labels and references only, never credentials`]);
      expect(errors.join(" ")).not.toContain(secret.slice(4, 16));
    }
  });

  it("refuses a key in a recognized credential format, whatever it holds, without repeating the key", () => {
    const keyToken = `ghp_${"k".repeat(36)}`;
    for (const value of ["ordinary", `Bearer ${"v".repeat(30)}`]) {
      const errors = errorsOf(moveReport({ seats: [{ seat: "dev-impl@team", result: "unknown", missing: "x", [keyToken]: value }] }));
      expect(errors).toEqual(["report.seats[0] has a key that looks like a GitHub token; a report holds labels and references only, never credentials"]);
      expect(errors.join(" ")).not.toContain(keyToken.slice(4, 20));
      expect(errors.join(" ")).not.toContain("v".repeat(30));
    }
  });

  it("doesn't treat labels, home paths or account names as credentials", () => {
    for (const value of [
      "/home/ubuntu/codexhomes/primaryaccountsharedbybuildmachines/sessions",
      "/Users/person/.openrig-build-vm-2d5beac5/codex-home",
      "two@example.com",
      "codex-1",
      "Account: Plus (two@example.com)",
      "sk-1",
      "the bearer of bad news",
    ]) {
      expect(findCredential({ home: value }), value).toBeNull();
    }
  });

  it("renders readable prose and the report as one block, and reads it back unchanged", () => {
    const report = moveReport({ follows: "qitem-20261023-earlier" });
    const check = checkMoveReport(report);
    if (!check.ok) throw new Error(check.errors.join("; "));
    const { summary, body } = renderMoveReport(check.report);
    expect(summary).toBe("Subscription move codex-1 → codex-2 on build-box: 1 moved, 1 unconfirmed, 1 peer");
    expect(body).toContain("**Policy:** account-policy, version 3");
    expect(body).toContain("**Follows:** qitem-20261023-earlier");
    expect(body).toContain("- dev-qa@team: unconfirmed; missing: no completed tool turn yet");
    expect(body).toContain("- codex-2: expected full since 2026-10-22T00:00:00.000Z (not measured; last reading 2026-10-20T09:00:00.000Z)");
    expect(body).toContain("- dev-lead@team: not restarted; account unverified");
    expect(readMoveReport(body)).toEqual({ ok: true, report });
  });

  it("reads back the report itself when its prose quotes an earlier report's block, whole or cut short", () => {
    const earlier = checkMoveReport(moveReport({ reason: "the first move" }));
    if (!earlier.ok) throw new Error(earlier.errors.join("; "));
    const earlierBody = renderMoveReport(earlier.report).body;
    for (const quoted of [earlierBody, earlierBody.slice(0, earlierBody.indexOf("\"readings\""))]) {
      const report = moveReport({ follows: "qitem-earlier", reason: `following up the report below:\n${quoted}` });
      const check = checkMoveReport(report);
      if (!check.ok) throw new Error(check.errors.join("; "));
      expect(readMoveReport(renderMoveReport(check.report).body)).toEqual({ ok: true, report });
    }
  });

  it("reads a body without the block, or with a broken one, as unreadable without quoting it", () => {
    expect(readMoveReport("moved some seats")).toEqual({ ok: false, errors: [`no ${MOVE_REPORT_FENCE} block`] });
    const broken = readMoveReport(`\`\`\`${MOVE_REPORT_FENCE}\n{ "reason": "Bearer ${"c".repeat(30)}" \n\`\`\``);
    expect(broken).toEqual({ ok: false, errors: [`the ${MOVE_REPORT_FENCE} block isn't valid JSON`] });
  });
});
