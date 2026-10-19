// Slice 01 — Codex reading history: a Codex account's readings (identity, windows, limit evidence, observation time)
// survive a daemon restart and a login switch, keyed only by the resolved identity key; the last observed exhaustion
// is kept; a passed reset shows an expectation that is planning, never a reading. Hermetic: a scripted reader over an
// in-memory database with every migration applied; nothing reads a real login.
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { CodexUsageWindows } from "../src/domain/provider/codex-usage-windows.js";
import { ClaudeUsageWindows } from "../src/domain/provider/claude-usage-windows.js";
import { ProviderAccountReadingsStore } from "../src/domain/provider/provider-account-readings.js";
import type { UsageReadOutcome } from "../src/domain/provider/usage-windows.js";
import { ACCOUNT_ANSWER, rateLimitsAnswer } from "./helpers/fake-codex-usage.js";

const T0 = "2026-10-12T20:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const epoch = (iso: string) => Date.parse(iso) / 1000;
type Answer = UsageReadOutcome<{ account: unknown; rateLimits: unknown }>;

function db() {
  const d = new Database(":memory:");
  migrate(d, ALL_MIGRATIONS);
  return d;
}
/** A windows cache over a scripted reader, a settable clock and the given database. */
function windows(d: Database.Database, answers: Answer[], start = T0) {
  let n = 0; let now = start;
  const w = new CodexUsageWindows({ now: () => now, read: async () => answers[Math.min(n++, answers.length - 1)]!, store: new ProviderAccountReadingsStore(d) });
  return { w, setNow: (iso: string) => { now = iso; } };
}
const read = (observedAt: string, opts: Parameters<typeof rateLimitsAnswer>[0] = {}, account: unknown = ACCOUNT_ANSWER): Answer =>
  ({ ok: true, observedAt, account, rateLimits: rateLimitsAnswer(opts) });
const rows = (d: Database.Database) => d.prepare("SELECT * FROM provider_account_readings ORDER BY id").all() as Array<Record<string, unknown>>;

describe("restart: history keeps its identity, evidence and times, and is never current", () => {
  it("an exhausted reading survives a restart as an earlier, stale row with unknown availability and its exhaustion time", async () => {
    const d = db();
    const first = windows(d, [read(T0, { primaryUsed: 100, reached: "rate_limit_reached", primaryResets: epoch(at(300)) })]);
    await first.w.refresh();
    // The daemon restarts: a new cache over the same database, before any refresh.
    const second = windows(d, [], at(10));
    const [row] = second.w.project(at(10));
    expect(row).toMatchObject({
      provider: "codex", observedAt: T0, latestFromSource: false, currentAvailability: "unknown", limitEvidence: "rate_limit_reached",
      identity: { accountId: "acct-1", limitId: "codex" }, retained: "before_restart", accountHistory: "linked",
      lastObservedExhausted: { at: T0, window: "primary" },
    });
    expect(row!.lastRefresh).toBeNull(); // no refresh since the restart: nothing current is claimed
    expect(row!.windows.every((w) => w.freshness === "stale")).toBe(true);
    expect(row!.windows[0]!.freshnessReason).toContain("before the daemon restarted");
  });

  it("a fresh read after the restart replaces the retained row for the same account", async () => {
    const d = db();
    await windows(d, [read(T0, { primaryUsed: 40 })]).w.refresh();
    const second = windows(d, [read(at(20), { primaryUsed: 55 })], at(20));
    await second.w.refresh();
    const current = second.w.project(at(20)).filter((r) => r.identity !== null);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ observedAt: at(20), latestFromSource: true });
    expect(current[0]).not.toHaveProperty("retained");
  });
});

describe("dedup includes the observation time", () => {
  it("a newer refresh with the same percentage and reset is a newer observation; the same observation isn't stored twice", async () => {
    const d = db();
    const store = new ProviderAccountReadingsStore(d);
    const same = { primaryUsed: 100, primaryResets: epoch(at(300)) };
    const { w, setNow } = windows(d, [read(T0, same), read(at(5), same)]);
    await w.refresh();
    expect(store.lastExhaustion("codex:account:acct-1:codex")!.at).toBe(T0);
    setNow(at(5)); await w.refresh();
    // Equal values, newer time: recorded, so the most recent observed exhaustion moves to it.
    expect(store.lastExhaustion("codex:account:acct-1:codex")!.at).toBe(at(5));
    const count = rows(d).length;
    // The same observation (time and values) again: not stored twice.
    store.record("codex:account:acct-1:codex", store.latest("codex:account:acct-1:codex")!);
    expect(rows(d)).toHaveLength(count);
  });
});

describe("no resurrected windows, no lost account-level evidence", () => {
  it("a later read without a window doesn't bring the window back, now or after a restart", async () => {
    const d = db();
    const noSecondary = read(at(5), { primaryUsed: 30 });
    ((noSecondary as { rateLimits: Record<string, unknown> }).rateLimits["rateLimits"] as Record<string, unknown>)["secondary"] = null;
    ((noSecondary as { rateLimits: Record<string, unknown> }).rateLimits["rateLimitsByLimitId"] as Record<string, Record<string, unknown>>)["codex"]!["secondary"] = null;
    const { w, setNow } = windows(d, [read(T0, { primaryUsed: 20, secondaryUsed: 50 }), noSecondary]);
    await w.refresh(); setNow(at(5)); await w.refresh();
    expect(w.project(at(5))[0]!.windows.map((x) => x.window)).toEqual(["primary"]);
    expect(windows(d, [], at(6)).w.project(at(6))[0]!.windows.map((x) => x.window)).toEqual(["primary"]);
  });

  it("a read with limit evidence but no window rows keeps its evidence across a restart", async () => {
    const d = db();
    const bare = read(T0, { reached: "rate_limit_reached" });
    for (const snap of [(bare as { rateLimits: Record<string, unknown> }).rateLimits["rateLimits"], ((bare as { rateLimits: Record<string, unknown> }).rateLimits["rateLimitsByLimitId"] as Record<string, unknown>)["codex"]] as Array<Record<string, unknown>>) {
      snap["primary"] = null; snap["secondary"] = null;
    }
    await windows(d, [bare]).w.refresh();
    const [row] = windows(d, [], at(1)).w.project(at(1));
    expect(row).toMatchObject({ windows: [], limitEvidence: "rate_limit_reached", lastObservedExhausted: { at: T0, window: null } });
  });
});

describe("expectations: per window and reset, planning only; a newer contrary reading wins", () => {
  it("a passed reset adds 'expected full since' to that window only, changing nothing measured", async () => {
    const d = db();
    const { w } = windows(d, [read(T0, { primaryUsed: 100, primaryResets: epoch(at(30)), secondaryUsed: 60, secondaryResets: epoch(at(3000)) })]);
    await w.refresh();
    const [row] = w.project(at(45));
    const [primary, secondary] = row!.windows;
    expect(primary).toMatchObject({ usedPercent: 100, level: "unknown", expectation: { expectedFullSince: at(30) } });
    expect(primary!.expectation!.note).toContain("planning, not a reading");
    expect(secondary).not.toHaveProperty("expectation");
    expect(row!.currentAvailability).not.toBe("known");
  });

  it("no reset, no expectation (never invented)", async () => {
    const d = db();
    const noReset = read(T0, { primaryUsed: 100 });
    ((noReset as { rateLimits: Record<string, unknown> }).rateLimits["rateLimits"] as Record<string, Record<string, unknown>>)["primary"]!["resetsAt"] = null;
    ((noReset as { rateLimits: Record<string, unknown> }).rateLimits["rateLimitsByLimitId"] as Record<string, Record<string, Record<string, unknown>>>)["codex"]!["primary"]!["resetsAt"] = null;
    const { w } = windows(d, [noReset]);
    await w.refresh();
    expect(w.project(at(10_000))[0]!.windows[0]).not.toHaveProperty("expectation");
  });

  it("a newer reading after the reset replaces the expectation", async () => {
    const d = db();
    const { w, setNow } = windows(d, [read(T0, { primaryUsed: 100, primaryResets: epoch(at(30)) }), read(at(40), { primaryUsed: 12, primaryResets: epoch(at(340)) })]);
    await w.refresh(); setNow(at(40)); await w.refresh();
    expect(w.project(at(41))[0]!.windows[0]).not.toHaveProperty("expectation");
    expect(w.project(at(41))[0]!.windows[0]!.usedPercent).toBe(12);
  });
});

describe("the no-credential boundary: the writer stores only selected normalized fields", () => {
  it("an extra unapproved field on the identity or a window is in no column and no JSON", () => {
    const d = db();
    const store = new ProviderAccountReadingsStore(d);
    store.record("codex:account:acct-1:codex", {
      identity: { accountId: "acct-1", workspaceId: null, limitId: "codex", email: "dev@example.test", planType: "plus", source: "account/rateLimits/read accountId", accessToken: "SYNTHETIC-SECRET-1" },
      windows: [{ window: "primary", durationMins: 300, usedPercent: 10, resetsAt: at(300), refreshToken: "SYNTHETIC-SECRET-2" }],
      limitEvidence: null, observedAt: T0, rawAuth: { token: "SYNTHETIC-SECRET-3" },
    } as never);
    const stored = JSON.stringify(rows(d));
    expect(stored).not.toContain("SYNTHETIC-SECRET");
    expect(stored).not.toMatch(/accessToken|refreshToken|rawAuth/);
    expect(rows(d)).toHaveLength(1);
  });
});

describe("retention: bounded per key", () => {
  it("21+ episodes keep the newest 20, repeated refreshes of one episode don't evict, and other keys are untouched", () => {
    const d = db();
    const store = new ProviderAccountReadingsStore(d);
    const ident = (accountId: string) => ({ accountId, workspaceId: null, limitId: "codex", email: null, planType: null, source: "account/rateLimits/read accountId" });
    const exhausted = (accountId: string, i: number, observedAt: string) => ({ identity: ident(accountId), limitEvidence: null, observedAt,
      windows: [{ window: "secondary", durationMins: 10080, usedPercent: 100, resetsAt: at(10_000 + i * 60) }] });
    // Key A: 25 distinct exhausted episodes (distinct resets), then 30 refreshes of the newest one.
    for (let i = 0; i < 25; i++) store.record("codex:account:A:codex", exhausted("A", i, at(i)) as never);
    for (let j = 0; j < 30; j++) store.record("codex:account:A:codex", exhausted("A", 24, at(100 + j)) as never);
    // Key B: 3 episodes.
    for (let i = 0; i < 3; i++) store.record("codex:account:B:codex", exhausted("B", i, at(i)) as never);
    const episodes = (key: string) => store.exhaustionEpisodes(key);
    expect(episodes("codex:account:A:codex")).toHaveLength(20);
    // The newest episode is kept, with its most recent observed-exhaustion time.
    expect(episodes("codex:account:A:codex")[0]).toMatchObject({ window: "secondary", resetsAt: at(10_000 + 24 * 60), lastObservedAt: at(129) });
    // The 5 oldest episodes are gone; episode 5 onwards remain.
    expect(episodes("codex:account:A:codex").at(-1)!.resetsAt).toBe(at(10_000 + 5 * 60));
    expect(episodes("codex:account:B:codex")).toHaveLength(3);
    // The latest reading per window is still there.
    expect(store.latest("codex:account:A:codex")!.observedAt).toBe(at(129));
  });
});

describe("Claude: account history unknown; each window stays its seat's own", () => {
  it("every Claude row reads account history unknown, and its windows name their seat", () => {
    const w = new ClaudeUsageWindows({ listSamples: () => [{ seatSession: "a@rig", window: "five_hour", usedPercent: 100, resetsAt: at(60), sampledAt: T0 }], now: () => T0 });
    const [row] = w.project(T0);
    expect(row).toMatchObject({ accountHistory: "unknown" });
    expect(row!.windows[0]).toMatchObject({ seatSession: "a@rig" });
    expect(row).not.toHaveProperty("lastObservedExhausted");
  });
});

describe("a malformed stored row is skipped on its own, never wiping the rest", () => {
  const A = "codex:account:acct-1:codex";
  const B = "codex:account:acct-2:codex";
  /** Account A read at T0 (exhausted), then a login switch to B at +5; then rows for A whose windows JSON is unreadable,
   *  newer than A's good one, written past the store (the store itself never writes one). */
  async function withMalformed() {
    const d = db();
    const { w, setNow } = windows(d, [
      read(T0, { primaryUsed: 100, primaryResets: epoch(at(300)) }),
      read(at(5), { primaryUsed: 30, accountId: "acct-2" }),
    ]);
    await w.refresh();
    setNow(at(5)); await w.refresh();
    const insert = d.prepare(`INSERT INTO provider_account_readings
        (provider, identity_key, account_id, workspace_id, limit_id, email, plan_type, identity_source, observed_at, limit_evidence, windows_json)
        VALUES ('codex', ?, 'acct-1', NULL, 'codex', NULL, NULL, 'account/rateLimits/read accountId', ?, NULL, ?)`);
    for (const [i, bad] of ["{not json", "{\"window\":\"primary\"}", "[null]"].entries()) insert.run(A, at(6 + i), bad);
    return d;
  }

  it("after a restart, the other account is fully restored and the bad row's account keeps its good rows", async () => {
    const d = await withMalformed();
    const restarted = windows(d, [], at(10)).w.project(at(10)).filter((r) => r.identity !== null);
    const byAccount = new Map(restarted.map((r) => [r.identity!.accountId, r]));
    expect(byAccount.get("acct-2")).toMatchObject({ observedAt: at(5), retained: "before_restart" });
    expect(byAccount.get("acct-2")!.windows[0]).toMatchObject({ usedPercent: 30 });
    expect(byAccount.get("acct-1")).toMatchObject({ observedAt: T0, retained: "before_restart", lastObservedExhausted: { at: T0, window: "primary" } });
    expect(byAccount.get("acct-1")!.windows[0]).toMatchObject({ usedPercent: 100 });
    const store = new ProviderAccountReadingsStore(d);
    expect(store.latest(A)!.observedAt).toBe(T0);
    expect(store.exhaustionEpisodes(A)).toHaveLength(1);
  });

  it("a new reading still persists, pruning doesn't throw, and the bad rows aren't rewritten or removed", async () => {
    const d = await withMalformed();
    const before = rows(d).filter((r) => r.observed_at !== T0 && r.identity_key === A);
    const store = new ProviderAccountReadingsStore(d);
    store.record(A, { identity: { accountId: "acct-1", workspaceId: null, limitId: "codex", email: null, planType: null, source: "account/rateLimits/read accountId" },
      windows: [{ window: "primary", durationMins: 300, usedPercent: 12, resetsAt: at(600) }], limitEvidence: null, observedAt: at(20) } as never);
    expect(store.latest(A)).toMatchObject({ observedAt: at(20), windows: [{ usedPercent: 12 }] });
    expect(rows(d).filter((r) => r.observed_at !== T0 && r.observed_at !== at(20) && r.identity_key === A)).toEqual(before);
    expect(store.latest(B)!.observedAt).toBe(at(5));
  });
});

describe("projection cost and restart guidance", () => {
  it("the last exhaustion is held in memory: projecting reads no store, and the value is unchanged across a restart", async () => {
    const d = db();
    let lookups = 0;
    const counting = () => {
      const store = new ProviderAccountReadingsStore(d);
      const lastExhaustion = store.lastExhaustion.bind(store);
      store.lastExhaustion = (key: string) => { lookups += 1; return lastExhaustion(key); };
      return store;
    };
    let n = 0;
    const answers = [read(T0, { primaryUsed: 100, primaryResets: epoch(at(300)) })];
    const live = new CodexUsageWindows({ now: () => at(1), read: async () => answers[Math.min(n++, 0)]!, store: counting() });
    await live.refresh();
    const before = live.project(at(1))[0]!.lastObservedExhausted;
    lookups = 0;
    for (let i = 0; i < 5; i++) live.project(at(2 + i));
    expect(lookups).toBe(0);
    const restarted = new CodexUsageWindows({ now: () => at(10), read: async () => answers[0]!, store: counting() });
    lookups = 0;
    for (let i = 0; i < 5; i++) restarted.project(at(10 + i));
    expect(lookups).toBe(0);
    expect(before).toEqual({ at: T0, window: "primary", evidence: "at the limit" });
    expect(restarted.project(at(10))[0]!.lastObservedExhausted).toEqual(before);
  });

  it("a retained row's windows say how to get a current reading", async () => {
    const d = db();
    await windows(d, [read(T0, { primaryUsed: 40 })]).w.refresh();
    const [row] = windows(d, [], at(10)).w.project(at(10));
    for (const w of row!.windows) expect(w.freshnessReason).toContain("refresh with rig provider status --refresh");
  });
});

describe("sign-in on rows kept from before a restart", () => {
  it("a restored row's sign-in says it was kept from before the restart, unlike a row a later live read superseded", async () => {
    const d = db();
    await windows(d, [read(T0, { primaryUsed: 40 })]).w.refresh();
    const restored = windows(d, [], at(10)).w.project(at(10)).find((r) => r.retained === "before_restart")!;
    expect(restored.signIn).toMatchObject({ state: "unknown", at: null });
    expect(restored.signIn!.evidence).toContain("kept from before the daemon restarted");
    expect(restored.signIn!.evidence).not.toContain("not the latest read");

    // The live contrast: one daemon reads account A, then account B; A's row is superseded, not restored.
    const live = windows(db(), [read(T0, { primaryUsed: 40 }), read(at(5), { primaryUsed: 10, accountId: "acct-2" })]);
    await live.w.refresh(); live.setNow(at(5)); await live.w.refresh();
    const superseded = live.w.project(at(5)).find((r) => !r.latestFromSource && r.identity !== null)!;
    expect(superseded.retained).toBeUndefined();
    expect(superseded.signIn!.evidence).toContain("not the latest read");
  });
});
