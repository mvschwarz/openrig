// Slice 01 (OPR.0.7.0.1) — Claude usage windows: the seats' status-line samples joined with the identity
// `claude auth status` reports on a refresh; the identity reader against a fake `claude`; and LOW-4 (rows a later
// read superseded age to stale).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { claudeAuthReaderEnv, claudeAuthStatusReader, type ClaudeAuthAnswer } from "../src/domain/provider/claude-auth-status-reader.js";
import { ClaudeUsageWindows, latestClaudeWindowSamples, type ClaudeWindowSample } from "../src/domain/provider/claude-usage-windows.js";
import { CodexUsageWindows } from "../src/domain/provider/codex-usage-windows.js";
import type { UsageReadOutcome } from "../src/domain/provider/usage-windows.js";
import { CLAUDE_AUTH, CLAUDE_LOGGED_OUT, makeFakeClaude } from "./helpers/fake-claude-usage.js";
import { ACCOUNT_ANSWER, rateLimitsAnswer } from "./helpers/fake-codex-usage.js";

const NOW = "2026-10-12T12:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
const sample = (seatSession: string, window: "five_hour" | "weekly", usedPercent: number, sampledAt: string, resetsAt = window === "weekly" ? at(2 * 1440) : at(120)): ClaudeWindowSample =>
  ({ seatSession, window, usedPercent, resetsAt, sampledAt });
const authOk = (auth: Record<string, unknown> = {}, observedAt = NOW): UsageReadOutcome<ClaudeAuthAnswer> =>
  ({ ok: true, observedAt, auth: { loggedIn: true, authMethod: "claude.ai", email: "d***@example.test", orgId: "org-1", orgName: "Example Org", subscriptionType: "team", ...auth } as ClaudeAuthAnswer["auth"] });

function windowsWith(samples: () => ClaudeWindowSample[], reads: Array<UsageReadOutcome<ClaudeAuthAnswer>> = []) {
  let n = 0;
  return new ClaudeUsageWindows({ readIdentity: async () => reads[Math.min(n++, reads.length - 1)]!, listSamples: samples, now: () => NOW });
}

describe("Claude windows: the seats' status-line samples", () => {
  it("each window is the freshest sample across seats, observed at the sample's own time, naming its seat", () => {
    const samples = [sample("a@rig", "five_hour", 20, at(-3)), sample("b@rig", "five_hour", 25, at(-1)), sample("a@rig", "weekly", 85, at(-3))];
    const [row] = windowsWith(() => samples).project(NOW);
    expect(row!.windows.map((w) => [w.window, w.usedPercent, w.observedAt, w.seatSession, w.level, w.freshness])).toEqual([
      ["five_hour", 25, at(-1), "b@rig", "ok", "fresh"],
      ["weekly", 85, at(-3), "a@rig", "nearing", "fresh"],
    ]);
    expect(row!.source).toEqual({ kind: "claude_statusline_samples", host: "local" });
  });

  it("an idle seat stops advancing, so its windows age to stale", () => {
    const [row] = windowsWith(() => [sample("a@rig", "weekly", 40, at(-20))]).project(NOW);
    expect(row!.windows[0]).toMatchObject({ freshness: "stale", freshnessReason: "observed 20 min ago (fresh for 15 min)" });
    expect(row!.currentAvailability).toBe("unknown");
  });

  it("seats with different fresh windows (possibly different logins) make the level unknown; nothing is merged", () => {
    const samples = [sample("a@rig", "weekly", 10, at(-1), at(2000)), sample("b@rig", "weekly", 90, at(-2), at(5000))];
    const [row] = windowsWith(() => samples).project(NOW);
    expect(row!.windows).toHaveLength(1);
    expect(row!.windows[0]).toMatchObject({ usedPercent: 10, seatSession: "a@rig", level: "unknown",
      levelReason: "Claude seats report different windows (possibly different logins): a@rig, b@rig",
      // Each disagreeing seat's own numbers, so which login is where reads from the row.
      disagreeingSeats: [{ seatSession: "b@rig", usedPercent: 90, resetsAt: at(5000), observedAt: at(-2) }] });
    // A stale disagreeing seat doesn't count.
    const [later] = windowsWith(() => [sample("a@rig", "weekly", 10, at(-1), at(2000)), sample("b@rig", "weekly", 90, at(-30), at(5000))]).project(NOW);
    expect(later!.windows[0]!.level).toBe("ok");
    expect(later!.windows[0]).not.toHaveProperty("disagreeingSeats");
  });

  it("no seat has reported: one explicit unavailable row", () => {
    expect(windowsWith(() => []).project(NOW)).toEqual([expect.objectContaining({
      provider: "claude", identity: null, windows: [], currentAvailability: "unknown", unavailableReason: "no Claude seat has reported status-line rate limits yet",
    })]);
  });

  it("samples that can't be read say so, without breaking the view", () => {
    const w = new ClaudeUsageWindows({ readIdentity: async () => authOk(), listSamples: () => { throw new Error("no such table: usage_samples"); }, now: () => NOW });
    expect(w.project(NOW)).toEqual([expect.objectContaining({ identity: null, unavailableReason: "the status-line samples could not be read: no such table: usage_samples" })]);
  });

  it("reads each seat's latest provider-window sample per window from usage_samples", () => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const insert = db.prepare(`INSERT INTO usage_samples (lane, seat_session, source, sampled_at, captured_at, window, window_used_percent, resets_at)
      VALUES (?, ?, 'claude_statusline_json', ?, ?, ?, ?, ?)`);
    insert.run("provider_window", "a@rig", at(-10), at(-10), "weekly", 30, at(2000));
    insert.run("provider_window", "a@rig", at(-2), at(-1), "weekly", 32, at(2000));
    insert.run("provider_window", "a@rig", at(-2), at(-1), "five_hour", 5, at(100));
    insert.run("provider_window", "b@rig", null, at(-1), "weekly", 50, at(2000));
    db.prepare(`INSERT INTO usage_samples (lane, seat_session, captured_at, used_percentage) VALUES ('context', 'a@rig', ?, 12)`).run(at(-1));
    expect(latestClaudeWindowSamples(db).sort((x, y) => x.window.localeCompare(y.window))).toEqual([
      { seatSession: "a@rig", window: "five_hour", usedPercent: 5, resetsAt: at(100), sampledAt: at(-2) },
      { seatSession: "a@rig", window: "weekly", usedPercent: 32, resetsAt: at(2000), sampledAt: at(-2) },
    ]);
    db.close();
  });
});

describe("Claude identity: claude auth status on refresh, joined and labelled, never stored", () => {
  const samples = () => [sample("a@rig", "five_hour", 20, at(-1)), sample("a@rig", "weekly", 50, at(-1))];

  it("before any refresh the windows show with the identity not read yet; a view never starts a read", () => {
    let reads = 0;
    const w = new ClaudeUsageWindows({ readIdentity: async () => { reads += 1; return authOk(); }, listSamples: samples, now: () => NOW });
    const [row] = w.project(NOW);
    expect(reads).toBe(0);
    expect(row).toMatchObject({
      identity: { orgId: null, email: null, limitId: "all models", source: "unresolved" },
      identityNote: "identity not read yet (rig provider status --refresh); windows: status-line readings from a@rig at their own times",
      unresolved: { note: "identity not read yet: not matched to, merged with or replacing any other row" },
      currentAvailability: "unknown",
    });
  });

  it("a refresh attaches the login as of then, labelled as not proven to be the same login; the windows stay the samples", async () => {
    const w = windowsWith(samples, [authOk()]);
    expect((await w.refresh()).refresh).toMatchObject({ outcome: "ok", at: NOW });
    const [row] = w.project(NOW);
    expect(row).toMatchObject({
      identity: { orgId: "org-1", email: "d***@example.test", limitId: "all models", orgName: "Example Org", subscriptionType: "team", source: "claude auth status orgId and email" },
      identityNote: `identity: the daemon's Claude login (claude auth status) as of the refresh at ${NOW}; windows: status-line readings from a@rig at their own times; not proven to be the same login`,
      latestFromSource: true,
      // Changed result: never "known" from this join; there's no sample-time seat-to-login link.
      currentAvailability: "unknown",
      unavailableReason: expect.stringContaining("no sample-time link"),
    });
    expect(row!.windows.map((w) => w.observedAt)).toEqual([at(-1), at(-1)]);
    expect(row).not.toHaveProperty("unresolved");
  });

  // Two hermetic source cases: the join had no sample-time link between a seat's window and the refreshed login, yet read
  // currentAvailability "known".
  it("the same reset on another login: a seat on a different login with the same reset is not attributed to the refreshed login; availability is unknown", async () => {
    const reset = at(2 * 1440);
    const mixed = () => [sample("a@rig", "weekly", 40, at(-10), reset), sample("b@rig", "weekly", 90, at(-1), reset)];
    const w = windowsWith(mixed, [authOk({ email: "a***@example.test" })]);
    await w.refresh();
    const [row] = w.project(NOW);
    // The freshest sample is seat b's, 90 % used, with the same reset as seat a's: nothing links it to login a.
    expect(row!.windows[0]).toMatchObject({ usedPercent: 90, seatSession: "b@rig" });
    expect(row).toMatchObject({ identity: { email: "a***@example.test" }, currentAvailability: "unknown",
      unavailableReason: expect.stringContaining("no sample-time link") });
  });

  it("a seat still on an earlier login: after the daemon's login changes, a seat still on the old login doesn't make the new login's row known", async () => {
    let live = [sample("a@rig", "weekly", 15, at(-6))];
    const w = new ClaudeUsageWindows({ listSamples: () => live, now: () => NOW,
      readIdentity: (() => { const reads = [authOk({ email: "a***@example.test" }, at(-6)), authOk({ email: "b***@example.test" }, NOW)]; let n = 0; return async () => reads[n++]!; })() });
    await w.refresh(); // login a at -6, with seat a@rig at 15 %
    live = [sample("a@rig", "weekly", 25, at(-1))]; // the seat still runs login a
    await w.refresh(); // the daemon's login is now b
    const [current, earlier] = w.project(NOW);
    expect(current).toMatchObject({ identity: { email: "b***@example.test" }, currentAvailability: "unknown",
      unavailableReason: expect.stringContaining("no sample-time link") });
    expect(current!.windows[0]).toMatchObject({ usedPercent: 25, seatSession: "a@rig" });
    // The frozen login-a row keeps its own refresh's reading, unchanged.
    expect(earlier).toMatchObject({ identity: { email: "a***@example.test" }, currentAvailability: "unknown", latestFromSource: false });
    expect(earlier!.windows[0]).toMatchObject({ usedPercent: 15, observedAt: at(-6) });
  });

  it("either organisation or email missing is unresolved", async () => {
    for (const missing of [{ orgId: null }, { email: null }]) {
      const w = windowsWith(samples, [authOk(missing)]);
      await w.refresh();
      expect(w.project(NOW)[0]).toMatchObject({ identity: { source: "unresolved" }, unresolved: { note: "identity unresolved: not matched to, merged with or replacing any other row" } });
    }
  });

  it("another login (a second member of the organisation) freezes the earlier row as it was at its own refresh, stale; nothing merged or relabelled", async () => {
    let live = [sample("a@rig", "weekly", 50, at(-1))];
    const w = windowsWith(() => live, [authOk(), authOk({ email: "e***@example.test" }, at(5))]);
    await w.refresh();
    live = [sample("a@rig", "weekly", 70, at(4))];
    await w.refresh();
    const rows = w.project(at(5));
    expect(rows.map((r) => [(r.identity as { email: string }).email, r.windows[0]!.usedPercent, r.latestFromSource, r.windows[0]!.freshness])).toEqual([
      ["e***@example.test", 70, true, "fresh"],
      ["d***@example.test", 50, false, "stale"],
    ]);
    expect(rows[1]!.windows[0]!.freshnessReason).toBe("a later read exists");
    expect(rows[1]!.identityNote).toBe(`identity: the daemon's Claude login as of the refresh at ${NOW}; a refresh at ${at(5)} reported another login, or one it couldn't identify; windows as they were at ${NOW} (from a@rig)`);
  });

  it("switching back to the earlier login makes its row current again; one email in two organisations is two rows", async () => {
    const w = windowsWith(samples, [authOk(), authOk({ orgId: "org-2" }), authOk()]);
    await w.refresh();
    await w.refresh();
    expect(w.project(NOW).map((r) => [(r.identity as { orgId: string }).orgId, r.latestFromSource])).toEqual([["org-2", true], ["org-1", false]]);
    await w.refresh();
    expect(w.project(NOW).map((r) => [(r.identity as { orgId: string }).orgId, r.latestFromSource])).toEqual([["org-1", true], ["org-2", false]]);
  });

  it("a failed refresh keeps the last identity and the sample windows, and says so", async () => {
    const w = windowsWith(samples, [authOk(), { ok: false, at: at(1), reason: "not_logged_in", detail: "claude auth status reports no login (exit 1)" }]);
    await w.refresh();
    expect((await w.refresh()).refresh).toMatchObject({ outcome: "failed", reason: "not_logged_in" });
    const [row] = w.project(at(1));
    expect(row).toMatchObject({ identity: { orgId: "org-1" }, lastRefresh: { outcome: "failed", reason: "not_logged_in" } });
    expect(row!.windows.every((x) => x.freshness === "fresh")).toBe(true);
  });

  it("overlapping refreshes share one identity read", async () => {
    let reads = 0;
    const w = new ClaudeUsageWindows({ readIdentity: async () => { reads += 1; await new Promise((r) => setTimeout(r, 50)); return authOk(); }, listSamples: samples, now: () => NOW });
    const results = await Promise.all([w.refresh(), w.refresh(), w.refresh()]);
    expect(reads).toBe(1);
    expect(results.map((r) => r.refresh.coalesced)).toEqual([false, true, true]);
  });
});

describe("LOW-4: a row a later read superseded ages to stale", () => {
  it("superseded resolved rows read stale: a later read exists, however recent", async () => {
    const outcomes = [
      { ok: true as const, observedAt: NOW, account: ACCOUNT_ANSWER, rateLimits: rateLimitsAnswer({ accountId: "acct-1" }) },
      { ok: true as const, observedAt: at(1), account: ACCOUNT_ANSWER, rateLimits: rateLimitsAnswer({ accountId: "acct-2" }) },
    ];
    let n = 0;
    const windows = new CodexUsageWindows({ now: () => NOW, read: async () => outcomes[n++]! });
    await windows.refresh();
    await windows.refresh();
    const [older, latest] = windows.project(at(2));
    expect(older!.windows.every((w) => w.freshness === "stale" && w.freshnessReason === "a later read exists")).toBe(true);
    expect(latest!.windows.every((w) => w.freshness === "fresh")).toBe(true);
  });
});

describe("claudeAuthStatusReader against a fake claude", () => {
  const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "claude-reader-home-"));
  const reader = (fake: ReturnType<typeof makeFakeClaude>, extra: { timeoutMs?: number; launchPath?: string; graceMs?: number } = {}) =>
    claudeAuthStatusReader({ launchPath: extra.launchPath ?? `${fake.binDir}${path.delimiter}${process.env.PATH}`, home: home(), claudeConfigDir: fake.configDir,
      timeoutMs: extra.timeoutMs ?? 5_000, graceMs: extra.graceMs ?? 500 });

  it("reads identity from auth status only, by absolute path, without TMUX, TMUX_PANE or seat variables", async () => {
    const fake = makeFakeClaude();
    fake.setPlan({ auth: [CLAUDE_AUTH] });
    expect(await reader(fake)()).toMatchObject({ ok: true, auth: { loggedIn: true, authMethod: "claude.ai", email: "d***@example.test", orgId: "org-1", orgName: "Example Org", subscriptionType: "team" } });
    expect(fake.authCalls()).toBe(1);
    expect(fake.otherStarts()).toEqual([]);
    expect(fake.authStarts()[0]).toMatchObject({ argv: ["auth", "status", "--json"], env: { TMUX: null, TMUX_PANE: null, OPENRIG_SESSION_NAME: null, CLAUDECODE: null } });
  });

  it("Claude's real logged-out answer ({loggedIn: false}, exit 1) is not_logged_in", async () => {
    const fake = makeFakeClaude();
    fake.setPlan({ auth: [CLAUDE_LOGGED_OUT] });
    expect(await reader(fake)()).toMatchObject({ ok: false, reason: "not_logged_in", detail: "claude auth status reports no login (exit 1)" });
    // Labelled: the same answer with exit 0 (not Claude's documented contract) reads the same.
    fake.setPlan({ auth: [CLAUDE_LOGGED_OUT], authExit: [0] });
    expect(await reader(fake)()).toMatchObject({ ok: false, reason: "not_logged_in", detail: "claude auth status reports no login" });
  });

  it("facts only from exit 0: any other nonzero answer, even valid logged-in JSON, is auth_status_failed", async () => {
    const fake = makeFakeClaude();
    // Only exit 1 is Claude's documented logged-out answer: {"loggedIn": false} with exit 9 is an unexpected failure.
    for (const [auth, exit] of [[CLAUDE_AUTH, 9], [CLAUDE_LOGGED_OUT, 9], [CLAUDE_LOGGED_OUT, 2], [{ authMethod: "claude.ai" }, 1], [{ loggedIn: "false" }, 1]] as const) {
      fake.setPlan({ auth: [auth], authExit: [exit] });
      expect(await reader(fake)(), JSON.stringify(auth)).toMatchObject({ ok: false, reason: "auth_status_failed", detail: `claude auth status failed (exit ${exit})` });
    }
    fake.setPlan({ auth: [null] });
    expect(await reader(fake)()).toMatchObject({ ok: false, reason: "auth_status_failed", detail: "claude auth status failed (exit 1)" });
  });

  it("an API-key login, no claude, and a hang", async () => {
    const fake = makeFakeClaude();
    fake.setPlan({ auth: [{ ...CLAUDE_AUTH, authMethod: "api_key" }] });
    expect(await reader(fake)()).toMatchObject({ ok: false, reason: "not_subscription_login" });
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "claude-reader-nobin-"));
    expect(await reader(fake, { launchPath: empty })()).toMatchObject({ ok: false, reason: "binary_not_found", detail: "no claude executable on the daemon's PATH" });
    fake.setPlan({ auth: ["hang"] });
    const started = performance.now();
    expect(await reader(fake, { timeoutMs: 1_000 })()).toMatchObject({ ok: false, reason: "auth_status_failed", detail: "claude auth status did not answer within 1 s" });
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("nothing a read starts survives it (answer, logged out, hang), with processes that ignore HUP and TERM", async () => {
    const fake = makeFakeClaude();
    // The reader reaps its own child before it returns; an orphaned stub child is reaped by init (launchd on macOS), so
    // every recorded pid and group must be gone within REAP_BOUND_MS; anything left is named with its ps state.
    const REAP_BOUND_MS = 2_000;
    const exists = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const psRows = () => execFileSync("ps", ["-A", "-o", "pid=,pgid=,stat="]).toString().trim().split("\n")
      .map((l) => l.trim().split(/\s+/)).map(([pid, pgid, stat]) => ({ pid: Number(pid), pgid: Number(pgid), stat: stat ?? "" }));
    const leftAfterReapBound = async (p: { pids: number[]; pgid: number }) => {
      const until = Date.now() + REAP_BOUND_MS;
      while (Date.now() < until && (p.pids.some(exists) || psRows().some((r) => r.pgid === p.pgid))) await new Promise((r) => setTimeout(r, 50));
      return psRows().filter((r) => p.pids.includes(r.pid) || r.pgid === p.pgid);
    };
    for (const [name, auth, outcome] of [["answer", CLAUDE_AUTH, "ok"], ["logged out", CLAUDE_LOGGED_OUT, "not_logged_in"], ["hang", "hang", "auth_status_failed"]] as const) {
      fake.setPlan({ auth: [auth], stubborn: true });
      const r = await reader(fake, { timeoutMs: 2_000, graceMs: 500 })();
      expect(r.ok ? "ok" : r.reason, name).toBe(outcome);
      const [p] = fake.procs();
      expect(p, name).toBeDefined();
      expect(exists(p!.pids[0]!), `${name}: auth status child ${p!.pids[0]} unreaped`).toBe(false);
      expect(await leftAfterReapBound(p!), `${name}: pids ${p!.pids.join(",")} group ${p!.pgid}`).toEqual([]);
    }
  }, 60_000);

  it("the child environment drops TMUX, TMUX_PANE and seat variables, and keeps the config dir", () => {
    const env = claudeAuthReaderEnv({ launchPath: "/p", home: "/h", claudeConfigDir: "/c" },
      { TMUX: "x", TMUX_PANE: "%1", OPENRIG_SESSION_NAME: "s@r", RIGGED_X: "1", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", KEEP: "k" });
    expect(env).toEqual({ KEEP: "k", PATH: "/p", HOME: "/h", CLAUDE_CONFIG_DIR: "/c", DISABLE_AUTOUPDATER: "1" });
  });
});
