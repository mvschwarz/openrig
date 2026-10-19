// Slice 01 (OPR.0.7.0.1) — Codex usage windows: the native read, the in-memory last reading, and
// the served rows (U2 level vs freshness, U3 failed refresh keeps the last reading).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexUsageReader, type CodexUsageReadOutcome } from "../src/domain/provider/codex-usage-reader.js";
import {
  CodexUsageWindows,
  normalizeCodexUsage,
  usageFreshness,
  usageLevel,
} from "../src/domain/provider/codex-usage-windows.js";
import { ACCOUNT_ANSWER, makeFakeCodex, rateLimitsAnswer } from "./helpers/fake-codex-usage.js";

const T0 = "2026-10-12T20:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const epoch = (iso: string) => Date.parse(iso) / 1000;

function okRead(rateLimits: unknown, observedAt = T0, account: unknown = ACCOUNT_ANSWER): CodexUsageReadOutcome {
  return { ok: true, observedAt, account, rateLimits };
}

/** A windows cache over a scripted reader and a settable clock. */
function scripted(outcomes: Array<CodexUsageReadOutcome | (() => Promise<CodexUsageReadOutcome>)>) {
  let now = T0;
  let reads = 0;
  const windows = new CodexUsageWindows({
    now: () => now,
    read: async () => {
      const next = outcomes[Math.min(reads, outcomes.length - 1)]!;
      reads += 1;
      return typeof next === "function" ? next() : next;
    },
  });
  return { windows, setNow: (iso: string) => { now = iso; }, reads: () => reads };
}

describe("normalizeCodexUsage (Codex 0.153.4 shapes)", () => {
  it("keys each bucket by (accountId, limitId), converts epoch-second resets, and keeps email and plan as labels", () => {
    const r = normalizeCodexUsage(ACCOUNT_ANSWER, rateLimitsAnswer({ primaryResets: epoch(at(120)) }), T0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.readings).toHaveLength(1);
    expect(r.readings[0]!.identity).toEqual({ accountId: "acct-1", workspaceId: null, limitId: "codex", email: "dev@example.test", planType: "plus", source: "account/rateLimits/read accountId" });
    expect(r.readings[0]!.windows[0]).toEqual({ window: "primary", durationMins: 300, usedPercent: 41, resetsAt: at(120) });
  });

  it("falls back to the single-bucket view when rateLimitsByLimitId is null", () => {
    const r = normalizeCodexUsage(ACCOUNT_ANSWER, rateLimitsAnswer({ byLimitId: false }), T0);
    expect(r.ok && r.readings.map((x) => x.identity.limitId)).toEqual(["codex"]);
  });

  it("with no usage account id: the workspace account/read reports (0.162.1's top-level workspaceRouting), else unresolved; never email", () => {
    const routed = { ...ACCOUNT_ANSWER, workspaceRouting: { chatgptAccountId: "ws-1", backendOrigin: "https://x", accountRoutingOverride: "us" } };
    expect(normalizeCodexUsage(routed, rateLimitsAnswer({ accountId: null }), T0).ok && (normalizeCodexUsage(routed, rateLimitsAnswer({ accountId: null }), T0) as { readings: Array<{ identity: unknown }> }).readings[0]!.identity)
      .toMatchObject({ accountId: null, workspaceId: "ws-1", source: "account/read workspace routing" });
    const r = normalizeCodexUsage(ACCOUNT_ANSWER, rateLimitsAnswer({ accountId: null }), T0);
    expect(r.ok && r.readings[0]!.identity).toMatchObject({ accountId: null, workspaceId: null, email: "dev@example.test", source: "unresolved" });
    // A usage account id wins over the workspace routing; workspaceRouting null and account null don't fail.
    expect((normalizeCodexUsage(routed, rateLimitsAnswer({}), T0) as { readings: Array<{ identity: unknown }> }).readings[0]!.identity).toMatchObject({ accountId: "acct-1", workspaceId: null });
    const bare = normalizeCodexUsage({ account: null, requiresOpenaiAuth: true, workspaceRouting: null }, rateLimitsAnswer({ accountId: null }), T0);
    expect(bare.ok && bare.readings[0]!.identity).toMatchObject({ email: null, planType: "plus", source: "unresolved" });
  });

  it("refuses shapes it doesn't recognize instead of guessing", () => {
    expect(normalizeCodexUsage(ACCOUNT_ANSWER, "nope", T0).ok).toBe(false);
    expect(normalizeCodexUsage(ACCOUNT_ANSWER, { rateLimits: null, rateLimitsByLimitId: null }, T0).ok).toBe(false);
    expect(normalizeCodexUsage(ACCOUNT_ANSWER, { rateLimitsByLimitId: { codex: { primary: { usedPercent: "41" } } } }, T0).ok).toBe(false);
  });
});

describe("level and freshness are separate questions", () => {
  const w = (usedPercent: number | null, resetsAt: string | null = at(600)) =>
    ({ window: "secondary" as const, durationMins: 10080, usedPercent, resetsAt });

  it("U2: 100% used is exhausted; 85% is nearing, not exhausted; 50% is ok", () => {
    expect(usageLevel(w(100), null, T0)).toEqual({ level: "exhausted", levelReason: "at the limit" });
    expect(usageLevel(w(85), null, T0)).toEqual({ level: "nearing", levelReason: "80% or more used" });
    expect(usageLevel(w(50), null, T0)).toEqual({ level: "ok" });
  });

  it("the bucket's provider limit evidence makes a window below 100% exhausted, with the reason said", () => {
    expect(usageLevel(w(40), "rate_limit_reached", T0)).toEqual({ level: "exhausted", levelReason: "provider limit evidence: rate_limit_reached" });
  });

  it("a passed reset needs a new reading: unknown, never a full quota, even with limit evidence", () => {
    expect(usageLevel(w(100, at(-1)), "rate_limit_reached", T0)).toEqual({ level: "unknown", levelReason: `reset passed at ${at(-1)}; a new reading is needed` });
  });

  it("absent data is neither nearing nor exhausted", () => {
    expect(usageLevel(w(null), "rate_limit_reached", T0)).toEqual({ level: "unknown", levelReason: "no usage reported for this window" });
  });

  it("freshness ages from the observation: fresh to 15 min, stale after; future beyond 60 s is unavailable", () => {
    expect(usageFreshness(T0, at(15), null)).toEqual({ freshness: "fresh" });
    expect(usageFreshness(T0, at(16), null)).toEqual({ freshness: "stale", freshnessReason: "observed 16 min ago (fresh for 15 min)" });
    expect(usageFreshness(at(0.5), T0, null)).toEqual({ freshness: "fresh" });
    expect(usageFreshness(at(2), T0, null).freshness).toBe("unavailable");
  });

  it("a reading older than a failed refresh is stale whatever its age", () => {
    expect(usageFreshness(T0, at(1), { at: at(1) })).toEqual({ freshness: "stale", freshnessReason: `refresh failed at ${at(1)}; this reading is older` });
  });
});

describe("CodexUsageWindows: rows, failed refresh, identity, coalescing", () => {
  it("before any read: one explicit unavailable row, never an empty answer", () => {
    const { windows } = scripted([okRead(rateLimitsAnswer({}))]);
    const rows = windows.project(T0);
    expect(rows).toEqual([expect.objectContaining({ identity: null, windows: [], currentAvailability: "unknown", unavailableReason: `no reading since the daemon started at ${T0}; refresh with rig provider status --refresh` })]);
  });

  it("U2: a Codex account at its weekly limit reads exhausted, fresh, with its own observation time", async () => {
    const { windows } = scripted([okRead(rateLimitsAnswer({ secondaryUsed: 100, secondaryResets: epoch(at(3000)) }))]);
    await windows.refresh();
    const [row] = windows.project(at(1));
    const weekly = row!.windows.find((x) => x.durationMins === 10080)!;
    expect(weekly).toMatchObject({ level: "exhausted", levelReason: "at the limit", freshness: "fresh", observedAt: T0, remainingPercent: 0 });
    expect(row!.currentAvailability).toBe("known");
  });

  it("limit evidence is shown once on the row and labels each window it upgrades", async () => {
    const { windows } = scripted([okRead(rateLimitsAnswer({ reached: "workspace_member_usage_limit_reached" }))]);
    await windows.refresh();
    const [row] = windows.project(at(1));
    expect(row!.limitEvidence).toBe("workspace_member_usage_limit_reached");
    expect(row!.windows.every((x) => x.level === "exhausted" && x.levelReason === "provider limit evidence: workspace_member_usage_limit_reached")).toBe(true);
  });

  it("U3: a failed refresh keeps the last reading with its original time, marked old, availability unknown", async () => {
    const s = scripted([okRead(rateLimitsAnswer({})), { ok: false, at: at(5), reason: "timeout", detail: "codex app-server did not answer within 35000 ms" }]);
    await s.windows.refresh();
    s.setNow(at(5));
    const result = await s.windows.refresh();
    expect(result.refresh).toEqual({ at: at(5), outcome: "failed", reason: "timeout", detail: "codex app-server did not answer within 35000 ms", coalesced: false });
    const [row] = s.windows.project(at(6));
    expect(row!.observedAt).toBe(T0);
    expect(row!.windows.every((x) => x.observedAt === T0 && x.freshness === "stale" && x.freshnessReason === `refresh failed at ${at(5)}; this reading is older`)).toBe(true);
    expect(row!.lastRefresh).toEqual({ at: at(5), outcome: "failed", reason: "timeout", detail: "codex app-server did not answer within 35000 ms" });
    expect(row!.currentAvailability).toBe("unknown");
  });

  it("an unrecognized answer is a failed refresh too, and keeps the reading", async () => {
    const s = scripted([okRead(rateLimitsAnswer({})), okRead({ rateLimits: "nope" }, at(2))]);
    await s.windows.refresh();
    expect((await s.windows.refresh()).refresh).toMatchObject({ outcome: "failed", reason: "unrecognized_shape" });
    expect(s.windows.project(at(3))[0]!.observedAt).toBe(T0);
  });

  it("the same email under another account id is a separate row; a later read for another account keeps the first as last seen", async () => {
    const s = scripted([okRead(rateLimitsAnswer({ accountId: "acct-1" })), okRead(rateLimitsAnswer({ accountId: "acct-2" }), at(1))]);
    await s.windows.refresh();
    await s.windows.refresh();
    const rows = s.windows.project(at(2));
    expect(rows.map((r) => [r.identity!.accountId, r.identity!.email, r.latestFromSource, r.observedAt])).toEqual([
      ["acct-1", "dev@example.test", false, T0],
      ["acct-2", "dev@example.test", true, at(1)],
    ]);
    expect(rows[0]!.currentAvailability).toBe("unknown");
  });

  it("equal resets never join two accounts", async () => {
    const s = scripted([okRead(rateLimitsAnswer({ accountId: "acct-1" })), okRead(rateLimitsAnswer({ accountId: "acct-9" }))]);
    await s.windows.refresh();
    await s.windows.refresh();
    expect(s.windows.project(at(1))).toHaveLength(2);
  });

  const routed = (ws: string) => ({ ...ACCOUNT_ANSWER, workspaceRouting: { chatgptAccountId: ws, backendOrigin: "https://x", accountRoutingOverride: "NO_CONSTRAINT" } });
  const ids = (rows: ReturnType<CodexUsageWindows["project"]>) =>
    rows.map((r) => [r.identity!.source, r.identity!.accountId ?? r.identity!.workspaceId, r.windows[1]!.usedPercent, r.latestFromSource]);

  it("F1: two workspaces under one email (workspace ids, no usage account id) are both kept", async () => {
    const s = scripted([okRead(rateLimitsAnswer({ accountId: null, secondaryUsed: 100 }), T0, routed("ws-a")), okRead(rateLimitsAnswer({ accountId: null, secondaryUsed: 20 }), at(1), routed("ws-b"))]);
    await s.windows.refresh();
    await s.windows.refresh();
    expect(ids(s.windows.project(at(2)))).toEqual([
      ["account/read workspace routing", "ws-a", 100, false],
      ["account/read workspace routing", "ws-b", 20, true],
    ]);
  });

  it("F1: two fully unresolved reads under one email are both kept, labelled, never merged", async () => {
    const s = scripted([okRead(rateLimitsAnswer({ accountId: null, secondaryUsed: 100 })), okRead(rateLimitsAnswer({ accountId: null, secondaryUsed: 20 }), at(1))]);
    await s.windows.refresh();
    await s.windows.refresh();
    const rows = s.windows.project(at(2));
    expect(ids(rows)).toEqual([["unresolved", null, 100, false], ["unresolved", null, 20, true]]);
    // LOW-4: the earlier unresolved row says it may be this same login; the latest keeps the plain note.
    expect(rows[0]!.unresolved).toEqual({ note: "identity unresolved: from an earlier read, possibly this same login; not matched to, merged with or replacing any other row", keptReads: 3, droppedReads: 0 });
    expect(rows[1]!.unresolved!.note).toBe("identity unresolved: not matched to, merged with or replacing any other row");
  });

  it("F1: a re-read of one workspace replaces only its own row", async () => {
    const s = scripted([
      okRead(rateLimitsAnswer({ accountId: null, secondaryUsed: 100 }), T0, routed("ws-a")),
      okRead(rateLimitsAnswer({ accountId: null, secondaryUsed: 20 }), at(1), routed("ws-b")),
      okRead(rateLimitsAnswer({ accountId: null, secondaryUsed: 30 }), at(2), routed("ws-a")),
    ]);
    for (let i = 0; i < 3; i++) await s.windows.refresh();
    expect(ids(s.windows.project(at(3)))).toEqual([
      ["account/read workspace routing", "ws-a", 30, true],
      ["account/read workspace routing", "ws-b", 20, false],
    ]);
  });

  it("F1: an unresolved read never replaces a resolved row", async () => {
    const s = scripted([okRead(rateLimitsAnswer({ secondaryUsed: 100 })), okRead(rateLimitsAnswer({ accountId: null, secondaryUsed: 20 }), at(1))]);
    await s.windows.refresh();
    await s.windows.refresh();
    expect(ids(s.windows.project(at(2)))).toEqual([
      ["account/rateLimits/read accountId", "acct-1", 100, false],
      ["unresolved", null, 20, true],
    ]);
  });

  it("F1: unresolved rows are kept from the 3 most recent unresolved reads, and the drop is counted", async () => {
    const s = scripted([1, 2, 3, 4, 5].map((n) => okRead(rateLimitsAnswer({ accountId: null, secondaryUsed: n }), at(n))));
    for (let i = 0; i < 5; i++) await s.windows.refresh();
    const rows = s.windows.project(at(6));
    expect(rows.map((r) => r.windows[1]!.usedPercent)).toEqual([3, 4, 5]);
    expect(rows.every((r) => r.unresolved?.keptReads === 3 && r.unresolved.droppedReads === 2)).toBe(true);
  });

  it("overlapping refreshes share one read; a refresh after it ends reads again (no stale join)", async () => {
    let release!: (o: CodexUsageReadOutcome) => void;
    const s = scripted([() => new Promise((resolve) => { release = resolve; }), okRead(rateLimitsAnswer({}), at(1))]);
    const first = s.windows.refresh();
    const second = s.windows.refresh();
    await Promise.resolve();
    release(okRead(rateLimitsAnswer({})));
    const [a, b] = await Promise.all([first, second]);
    expect(s.reads()).toBe(1);
    expect(a.refresh.coalesced).toBe(false);
    expect(b.refresh).toEqual({ at: T0, outcome: "ok", coalesced: true });
    const third = await s.windows.refresh();
    expect(s.reads()).toBe(2);
    expect(third.refresh).toEqual({ at: at(1), outcome: "ok", coalesced: false });
  });
});

describe("codexUsageReader against a fake codex app-server", () => {
  const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "usage-reader-home-"));
  const reader = (fake: ReturnType<typeof makeFakeCodex>, deadlineMs = 5_000) =>
    codexUsageReader({ launchPath: `${fake.binDir}${path.delimiter}${process.env.PATH}`, home: home(), codexHome: fake.codexHome, deadlineMs, graceMs: 200 });

  it("reads account/read and account/rateLimits/read and returns them as sent", async () => {
    const fake = makeFakeCodex();
    fake.setPlan({ mode: "ok", account: ACCOUNT_ANSWER, rateLimits: rateLimitsAnswer({}) });
    const r = await reader(fake)();
    expect(r).toMatchObject({ ok: true, account: ACCOUNT_ANSWER, rateLimits: rateLimitsAnswer({}) });
    expect(fake.spawns()).toBe(1);
    // Plugins and apps off for this read, as the #275 network reader starts the app-server.
    expect(fs.readFileSync(path.join(fake.codexHome, "spawns.log"), "utf8")).toBe("-c features.plugins=false -c features.apps=false app-server\n");
  });

  it("U3 failure reasons: rpc error, timeout, child exit", async () => {
    const fake = makeFakeCodex();
    fake.setPlan({ mode: "rpc_error" });
    expect(await reader(fake)()).toMatchObject({ ok: false, reason: "rpc_error", detail: "codex app-server returned an error for account/rateLimits/read: backend unavailable" });
    fake.setPlan({ mode: "hang" });
    expect(await reader(fake, 400)()).toMatchObject({ ok: false, reason: "timeout", detail: "codex app-server did not answer within 400 ms" });
    fake.setPlan({ mode: "exit" });
    expect(await reader(fake)()).toMatchObject({ ok: false, reason: "child_exited" });
  });

  it("no codex binary on PATH is its own reason", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "usage-reader-nobin-"));
    const r = await codexUsageReader({ launchPath: empty, home: home(), codexHome: empty, deadlineMs: 2_000 })();
    expect(r).toMatchObject({ ok: false, reason: "binary_not_found", detail: "no codex executable on the daemon's PATH" });
  });

  it("an unrecognized answer reaches the cache as unrecognized_shape", async () => {
    const fake = makeFakeCodex();
    fake.setPlan({ mode: "bad_shape" });
    const windows = new CodexUsageWindows({ read: reader(fake) });
    expect((await windows.refresh()).refresh).toMatchObject({ outcome: "failed", reason: "unrecognized_shape" });
  });

  it("overlapping refreshes through the real reader start one child; the next refresh starts another", async () => {
    const fake = makeFakeCodex();
    fake.setPlan({ mode: "ok", delayMs: 300, account: ACCOUNT_ANSWER, rateLimits: rateLimitsAnswer({}) });
    const windows = new CodexUsageWindows({ read: reader(fake) });
    const results = await Promise.all([windows.refresh(), windows.refresh(), windows.refresh()]);
    expect(fake.spawns()).toBe(1);
    expect(results.map((r) => r.refresh.coalesced)).toEqual([false, true, true]);
    await windows.refresh();
    expect(fake.spawns()).toBe(2);
  });
});
