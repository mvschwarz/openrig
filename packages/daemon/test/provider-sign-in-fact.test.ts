// Slice 01 — each account row's sign-in fact (usable / needs_sign_in / unknown), read from the evidence the
// existing refreshes already hold, kept apart from usage. Hermetic: a scripted reader, a fake `codex` app-server and
// scripted `claude auth status` outcomes; nothing reads a real login.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexUsageReader } from "../src/domain/provider/codex-usage-reader.js";
import { CodexUsageWindows } from "../src/domain/provider/codex-usage-windows.js";
import { ClaudeUsageWindows, type ClaudeWindowSample } from "../src/domain/provider/claude-usage-windows.js";
import type { ClaudeAuthAnswer } from "../src/domain/provider/claude-auth-status-reader.js";
import type { UsageReadOutcome } from "../src/domain/provider/usage-windows.js";
import { ACCOUNT_ANSWER, makeFakeCodex, rateLimitsAnswer } from "./helpers/fake-codex-usage.js";

const NOW = "2026-10-12T12:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "sign-in-home-"));

function codex(outcomes: Array<UsageReadOutcome<{ account: unknown; rateLimits: unknown }>>) {
  let n = 0;
  return new CodexUsageWindows({ now: () => NOW, read: async () => outcomes[Math.min(n++, outcomes.length - 1)]! });
}
const okCodex = (account: unknown = ACCOUNT_ANSWER, observedAt = NOW) => ({ ok: true as const, observedAt, account, rateLimits: rateLimitsAnswer({}) });

describe("Codex: the sign-in fact from the existing refresh", () => {
  it("no refresh yet: unknown", () => {
    const [row] = codex([]).project(NOW);
    expect(row!.signIn).toMatchObject({ state: "unknown", at: null });
  });

  it("a refresh whose rate-limit read was answered: usable, as of that refresh", async () => {
    const w = codex([okCodex()]);
    await w.refresh();
    const [row] = w.project(at(5));
    expect(row!.signIn).toEqual({ state: "usable", at: NOW,
      evidence: "the refresh's rate-limit read was answered for this login (the daemon's CODEX_HOME)" });
  });

  it("a refresh that found no signed-in account: needs_sign_in", async () => {
    const w = codex([{ ok: false, at: NOW, reason: "not_signed_in", detail: "x" }]);
    await w.refresh();
    const [row] = w.project(NOW);
    expect(row!.signIn).toMatchObject({ state: "needs_sign_in", at: NOW });
  });

  it("any other failed refresh: unknown, naming the reason", async () => {
    const w = codex([{ ok: false, at: NOW, reason: "rpc_error", detail: "backend unavailable" }]);
    await w.refresh();
    expect(w.project(NOW)[0]!.signIn).toMatchObject({ state: "unknown", at: NOW, evidence: expect.stringContaining("rpc_error") });
  });

  it("a usable login whose next refresh failed is no longer usable: unknown, from the newer failure", async () => {
    const w = codex([okCodex(), { ok: false, at: at(10), reason: "timeout", detail: "slow" }]);
    await w.refresh(); await w.refresh();
    expect(w.project(at(11))[0]!.signIn).toMatchObject({ state: "unknown", at: at(10) });
  });

  it("a row a later read superseded is not the latest read: unknown", async () => {
    const other = { account: { type: "chatgpt", email: "other@example.test", planType: "pro" }, requiresOpenaiAuth: true };
    let n = 0;
    const answers = [okCodex(), { ok: true as const, observedAt: at(10), account: other, rateLimits: rateLimitsAnswer({ accountId: "acct-2" }) }];
    const w = new CodexUsageWindows({ now: () => at(10), read: async () => answers[Math.min(n++, 1)]! });
    await w.refresh(); await w.refresh();
    const rows = w.project(at(11));
    expect(rows.find((r) => r.latestFromSource)!.signIn).toMatchObject({ state: "usable" });
    expect(rows.find((r) => !r.latestFromSource)!.signIn).toMatchObject({ state: "unknown", evidence: expect.stringContaining("not the latest read") });
  });

  it("an earlier UNRESOLVED read isn't called another login: possibly this same login, still unknown", async () => {
    let n = 0;
    const unresolvedRead = (observedAt: string) => ({ ok: true as const, observedAt, account: ACCOUNT_ANSWER, rateLimits: rateLimitsAnswer({ accountId: null }) });
    const answers = [unresolvedRead(NOW), unresolvedRead(at(10))];
    const w = new CodexUsageWindows({ now: () => at(10), read: async () => answers[Math.min(n++, 1)]! });
    await w.refresh(); await w.refresh();
    const earlier = w.project(at(11)).find((r) => !r.latestFromSource)!;
    expect(earlier.unresolved).toBeTruthy();
    expect(earlier.signIn).toMatchObject({ state: "unknown", evidence: expect.stringContaining("possibly this same login") });
    expect(earlier.signIn!.evidence).not.toMatch(/another/);
  });

  it("not inferred from usage: fresh windows, availability known, but the fact comes only from the refresh outcome", async () => {
    const w = codex([okCodex()]);
    await w.refresh();
    const [row] = w.project(NOW);
    expect(row!.currentAvailability).toBe("known");
    expect(row!.signIn!.state).toBe("usable");
    const failed = codex([{ ok: false, at: NOW, reason: "rpc_error", detail: "x" }]);
    await failed.refresh();
    expect(failed.project(NOW)[0]!.signIn!.state).toBe("unknown");
  });
});

describe("a signed-out refresh that identifies no account (round 2)", () => {
  it("Codex: success for A, then not_signed_in: A stays unknown; the current home's needs-sign-in is its own row", async () => {
    const w = codex([okCodex(), { ok: false, at: at(1), reason: "not_signed_in", detail: "no account" }]);
    await w.refresh(); await w.refresh();
    const rows = w.project(at(1));
    const a = rows.find((r) => r.identity !== null)!;
    expect(a.signIn).toMatchObject({ state: "unknown", at: at(1) });
    expect(a.signIn!.evidence).toContain("didn't identify an account");
    const home = rows.find((r) => r.identity === null)!;
    expect(home).toMatchObject({ windows: [], currentAvailability: "unknown", signIn: { state: "needs_sign_in", at: at(1) } });
    expect(home.unavailableReason).toContain("the daemon's CODEX_HOME");
  });

  it("Codex: success for A, then another failure: A unknown, and no extra row", async () => {
    const w = codex([okCodex(), { ok: false, at: at(1), reason: "timeout", detail: "slow" }]);
    await w.refresh(); await w.refresh();
    const rows = w.project(at(1));
    expect(rows.filter((r) => r.identity === null)).toEqual([]);
    expect(rows[0]!.signIn).toMatchObject({ state: "unknown", evidence: expect.stringContaining("timeout") });
  });

  it("Claude: success for A, then not_logged_in: A stays unknown; the current config's needs-sign-in is its own row", async () => {
    const w = claude([authOk(), { ok: false, at: at(1), reason: "not_logged_in", detail: "no login" }]);
    await w.refresh(); await w.refresh();
    const rows = w.project(at(1));
    const a = rows.find((r) => r.identity !== null)!;
    expect(a.signIn).toMatchObject({ state: "unknown" });
    expect(a.signIn!.evidence).toContain("didn't identify a login");
    const home = rows.find((r) => r.identity === null)!;
    expect(home).toMatchObject({ windows: [], signIn: { state: "needs_sign_in", at: at(1) } });
  });

  it("control: a signed-out refresh on an empty store still reads needs_sign_in on the one row (both providers)", async () => {
    const c = codex([{ ok: false, at: NOW, reason: "not_signed_in", detail: "x" }]); await c.refresh();
    expect(c.project(NOW)).toHaveLength(1);
    expect(c.project(NOW)[0]!.signIn!.state).toBe("needs_sign_in");
    const l = claude([{ ok: false, at: NOW, reason: "not_logged_in", detail: "x" }], []); await l.refresh();
    expect(l.project(NOW)).toHaveLength(1);
    expect(l.project(NOW)[0]!.signIn!.state).toBe("needs_sign_in");
  });
});

describe("superseded rows don't claim another login (round 2)", () => {
  it("Codex: a bucket the same account's next read no longer reports isn't called another login", async () => {
    const both = { ...rateLimitsAnswer({}) } as Record<string, unknown>;
    const twoBuckets = { ...both, rateLimitsByLimitId: { codex: (both as { rateLimits: unknown }).rateLimits, other: { ...(both as { rateLimits: Record<string, unknown> }).rateLimits, limitId: "other" } } };
    let n = 0;
    const answers = [{ ok: true as const, observedAt: NOW, account: ACCOUNT_ANSWER, rateLimits: twoBuckets }, { ...okCodex(ACCOUNT_ANSWER, at(10)) }];
    const w = new CodexUsageWindows({ now: () => at(10), read: async () => answers[Math.min(n++, 1)]! });
    await w.refresh(); await w.refresh();
    const dropped = w.project(at(11)).find((r) => !r.latestFromSource && r.identity !== null)!;
    expect(dropped).toBeTruthy();
    expect(dropped.signIn!.evidence).not.toMatch(/read another one|another login$/);
    expect(dropped.signIn!.evidence).toContain("this bucket no longer reported");
  });

  it("Codex: a resolved row followed by an unresolved read says it may not be another login", async () => {
    let n = 0;
    const answers = [okCodex(), { ok: true as const, observedAt: at(10), account: ACCOUNT_ANSWER, rateLimits: rateLimitsAnswer({ accountId: null }) }];
    const w = new CodexUsageWindows({ now: () => at(10), read: async () => answers[Math.min(n++, 1)]! });
    await w.refresh(); await w.refresh();
    const earlier = w.project(at(11)).find((r) => !r.latestFromSource && r.unresolved === undefined)!;
    expect(earlier.signIn!.evidence).toContain("one it couldn't identify");
  });

  it("Claude: a resolved login followed by an unidentified one: the row and its note say 'or one it couldn't identify'", async () => {
    const unidentified: UsageReadOutcome<ClaudeAuthAnswer> = { ok: true, observedAt: NOW, auth: { loggedIn: true, authMethod: "claude.ai", email: null, orgId: null, orgName: null, subscriptionType: "team" } as unknown as ClaudeAuthAnswer["auth"] };
    const w = claude([authOk(), unidentified]);
    await w.refresh(); await w.refresh();
    const earlier = w.project(NOW).find((r) => !r.latestFromSource && r.unresolved === undefined)!;
    expect(earlier.signIn!.evidence).toContain("or one it couldn't identify");
    // The current login is unknown and may be this same one, so the row never claims it isn't.
    expect(earlier.signIn!.evidence).not.toContain("not the current login");
    expect(earlier.identityNote).toContain("reported another login, or one it couldn't identify");
  });
});

describe("the Codex reader: a signed-out account/read answer is a named failure (no new read)", () => {
  const reader = (fake: ReturnType<typeof makeFakeCodex>) =>
    codexUsageReader({ launchPath: `${fake.binDir}${path.delimiter}${process.env.PATH}`, home: home(), codexHome: fake.codexHome, deadlineMs: 5_000, graceMs: 200 });

  it("account/read reports no account and the rate-limit read errors: not_signed_in", async () => {
    const fake = makeFakeCodex();
    fake.setPlan({ mode: "rpc_error", account: { account: null, requiresOpenaiAuth: true } });
    expect(await reader(fake)()).toMatchObject({ ok: false, reason: "not_signed_in",
      detail: "codex app-server's account/read reported no signed-in account; account/rateLimits/read then failed: backend unavailable" });
    expect(fake.spawns()).toBe(1);
  });

  it("a signed-in account whose rate-limit read errors stays rpc_error", async () => {
    const fake = makeFakeCodex();
    fake.setPlan({ mode: "rpc_error", account: ACCOUNT_ANSWER });
    expect(await reader(fake)()).toMatchObject({ ok: false, reason: "rpc_error" });
  });

  it("no account, but the rate-limit read answered: not reclassified (the read succeeded)", async () => {
    const fake = makeFakeCodex();
    fake.setPlan({ mode: "ok", account: { account: null, requiresOpenaiAuth: true }, rateLimits: rateLimitsAnswer({}) });
    expect(await reader(fake)()).toMatchObject({ ok: true });
  });
});

const sample = (seatSession: string, usedPercent: number): ClaudeWindowSample =>
  ({ seatSession, window: "five_hour", usedPercent, resetsAt: at(120), sampledAt: NOW });
const authOk = (): UsageReadOutcome<ClaudeAuthAnswer> =>
  ({ ok: true, observedAt: NOW, auth: { loggedIn: true, authMethod: "claude.ai", email: "d***@example.test", orgId: "org-1", orgName: "Example Org", subscriptionType: "team" } as ClaudeAuthAnswer["auth"] });
function claude(reads: Array<UsageReadOutcome<ClaudeAuthAnswer>>, samples: ClaudeWindowSample[] = [sample("a@r", 10)]) {
  let n = 0;
  return new ClaudeUsageWindows({ readIdentity: async () => reads[Math.min(n++, reads.length - 1)]!, listSamples: () => samples, now: () => NOW });
}

describe("Claude: at most unknown when signed in; needs_sign_in only when claude auth status reports no login", () => {
  it("no refresh yet: unknown", () => {
    expect(claude([]).project(NOW)[0]!.signIn).toMatchObject({ state: "unknown", at: null });
  });

  it("a stored claude.ai login is present: unknown, because nothing checks that it works", async () => {
    const w = claude([authOk()]);
    await w.refresh();
    expect(w.project(NOW)[0]!.signIn).toEqual({ state: "unknown", at: NOW,
      evidence: "claude auth status reports a stored claude.ai login; whether it works isn't checked (no read here contacts the service)" });
  });

  it("claude auth status reports no login: needs_sign_in", async () => {
    const w = claude([{ ok: false, at: NOW, reason: "not_logged_in", detail: "claude auth status reports no login (exit 1)" }]);
    await w.refresh();
    expect(w.project(NOW)[0]!.signIn).toMatchObject({ state: "needs_sign_in", at: NOW });
  });

  it.each(["auth_status_failed", "not_subscription_login", "binary_not_found"])("%s: unknown, naming the reason", async (reason) => {
    const w = claude([{ ok: false, at: NOW, reason, detail: "x" }]);
    await w.refresh();
    expect(w.project(NOW)[0]!.signIn).toMatchObject({ state: "unknown", evidence: expect.stringContaining(reason) });
  });

  it("with no seat samples the row still carries the fact", async () => {
    const w = claude([{ ok: false, at: NOW, reason: "not_logged_in", detail: "x" }], []);
    await w.refresh();
    expect(w.project(NOW)[0]!.signIn!.state).toBe("needs_sign_in");
  });
});

describe("Claude: earlier rows", () => {
  const unresolvedAuth = (observedAt: string): UsageReadOutcome<ClaudeAuthAnswer> =>
    ({ ok: true, observedAt, auth: { loggedIn: true, authMethod: "claude.ai", email: null, orgId: null, orgName: null, subscriptionType: "team" } as unknown as ClaudeAuthAnswer["auth"] });
  it("an earlier unresolved identity isn't called another login", async () => {
    const w = claude([unresolvedAuth(NOW), authOk()]);
    await w.refresh(); await w.refresh();
    const earlier = w.project(NOW).find((r) => !r.latestFromSource)!;
    expect(earlier.unresolved).toBeTruthy();
    expect(earlier.signIn).toMatchObject({ state: "unknown", evidence: expect.stringContaining("possibly this same login") });
    expect(earlier.signIn!.evidence).not.toMatch(/another/);
  });
  it("an earlier resolved login another refresh replaced reads 'not the latest read'", async () => {
    const other: UsageReadOutcome<ClaudeAuthAnswer> = { ok: true, observedAt: NOW, auth: { loggedIn: true, authMethod: "claude.ai", email: "o***@example.test", orgId: "org-2", orgName: "Other", subscriptionType: "team" } as ClaudeAuthAnswer["auth"] };
    const w = claude([authOk(), other]);
    await w.refresh(); await w.refresh();
    expect(w.project(NOW).find((r) => !r.latestFromSource)!.signIn).toMatchObject({ state: "unknown", evidence: expect.stringContaining("not the latest read") });
  });
});

describe("the Claude reason: where to see each seat's readings, and no 'this login' before one is read", () => {
  it("after a refresh, the reason points at each seat's own readings", async () => {
    const w = claude([authOk()]);
    await w.refresh();
    expect(w.project(NOW)[0]!.unavailableReason).toContain("each seat's own readings: rig usage series --seat <seat> --lane provider_window");
  });
  it("before any refresh, it names the daemon's login as not read yet, not 'this login'", () => {
    const reason = claude([]).project(NOW)[0]!.unavailableReason!;
    expect(reason).toContain("the daemon's Claude login (not read yet; refresh with rig provider status --refresh)");
    expect(reason).not.toContain("this login");
    expect(reason).toContain("rig usage series --seat <seat> --lane provider_window");
  });
});

describe("no consumer decides on it", () => {
  it("subscription moves and the in-place restart don't read the sign-in fact", () => {
    const src = path.join(__dirname, "..", "src", "domain");
    for (const file of ["provider/subscription-moves.ts", "seat-restart-in-place.ts", "seat-lifecycle-service.ts"]) {
      // The row field or its type; an unrelated local named `signIn` (the restart's sign-in step) is not a read of it.
      expect(fs.readFileSync(path.join(src, file), "utf8")).not.toMatch(/\.signIn\b|\bSignInFact\b/);
    }
  });
});
