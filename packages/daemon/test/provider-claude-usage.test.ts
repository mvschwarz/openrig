// Slice 01 (OPR.0.7.0.1) — Claude usage windows: the `/usage` screen parser, the identity rule, the
// reader in its private tmux server against a fake `claude`, and LOW-4 (superseded rows age to stale).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { claudeResetUtc, parseClaudeUsageScreen } from "../src/domain/provider/claude-usage-screen.js";
import {
  CLAUDE_USAGE_NO_MODEL,
  claudeUsageReader,
  claudeUsageReaderEnv,
  type ClaudeUsageAnswer,
} from "../src/domain/provider/claude-usage-screen-reader.js";
import { ClaudeUsageWindows, normalizeClaudeUsage } from "../src/domain/provider/claude-usage-windows.js";
import { CodexUsageWindows } from "../src/domain/provider/codex-usage-windows.js";
import type { UsageReadOutcome } from "../src/domain/provider/usage-windows.js";
import { CLAUDE_AUTH, makeFakeClaude, usageScreen } from "./helpers/fake-claude-usage.js";
import { ACCOUNT_ANSWER, rateLimitsAnswer } from "./helpers/fake-codex-usage.js";

const NOW = "2026-10-12T12:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

describe("Claude /usage screen parsing (pinned shapes)", () => {
  it("reads the session and all-models week with UTC resets", () => {
    const r = parseClaudeUsageScreen(usageScreen(), NOW);
    expect(r).toEqual({ ok: true, buckets: [{ bucket: "all models", windows: [
      { window: "current_session", durationMins: 300, usedPercent: 23, resetsAt: "2026-10-12T15:00:00.000Z" },
      { window: "current_week", durationMins: 10080, usedPercent: 41, resetsAt: "2026-10-14T09:00:00.000Z" },
    ] }] });
  });

  it("keeps a model-specific week as its own bucket", () => {
    const r = parseClaudeUsageScreen(usageScreen({ extra: " Current week (Opus)\n █ 12% used\n Resets Oct 15 at 1:30pm (UTC)" }), NOW);
    expect(r.ok && r.buckets.map((b) => [b.bucket, b.windows.map((w) => [w.window, w.usedPercent, w.resetsAt])])).toEqual([
      ["all models", [["current_session", 23, "2026-10-12T15:00:00.000Z"], ["current_week", 41, "2026-10-14T09:00:00.000Z"]]],
      ["Opus", [["current_week", 12, "2026-10-15T13:30:00.000Z"]]],
    ]);
  });

  it("reset forms: a bare time is its next occurrence; an old date rolls to next year; anything else is refused", () => {
    expect(claudeResetUtc("11am (UTC)", NOW)).toBe("2026-10-13T11:00:00.000Z");
    expect(claudeResetUtc("12pm (UTC)", NOW)).toBe("2026-10-12T12:00:00.000Z");
    expect(claudeResetUtc("Jan 3, 12am (UTC)", NOW)).toBe("2027-01-03T00:00:00.000Z");
    expect(claudeResetUtc("Jan 3, 12am (UTC)", "2026-12-30T00:00:00.000Z")).toBe("2027-01-03T00:00:00.000Z");
    for (const bad of ["3pm", "3pm (PDT)", "13pm (UTC)", "Foo 3, 3pm (UTC)", "in 2 hours"]) expect(claudeResetUtc(bad, NOW), bad).toBeNull();
  });

  it("a date that doesn't exist is refused, never rolled into the next month", () => {
    for (const bad of ["Apr 31, 9am (UTC)", "Feb 30 at 9am (UTC)", "Nov 31, 1am (UTC)", "Oct 0, 9am (UTC)"]) expect(claudeResetUtc(bad, NOW), bad).toBeNull();
    expect(claudeResetUtc("Oct 31, 9am (UTC)", NOW)).toBe("2026-10-31T09:00:00.000Z");
    expect(parseClaudeUsageScreen(usageScreen({ weekReset: "Apr 31, 9am (UTC)" }), NOW)).toMatchObject({ ok: false, detail: expect.stringContaining("unrecognized reset text") });
  });

  it("the percentage is its own unsigned token, 0-100: `<1%`, `-5%` and `>99%` are not values", () => {
    const week = (text: string) => usageScreen().replace("41% used", text);
    for (const bad of ["<1% used", "-5% used", ">99% used", "█-5% used", "~3% used", "1000% used"]) {
      expect(parseClaudeUsageScreen(week(bad), NOW), bad).toMatchObject({ ok: false, detail: expect.stringContaining("unrecognized percentage under Current week (all models)") });
    }
    expect(parseClaudeUsageScreen(week("100.5% used"), NOW)).toMatchObject({ ok: false, detail: expect.stringContaining("out of range") });
    for (const [good, value] of [["0% used", 0], ["100% used", 100], ["2.5% used", 2.5]] as const) {
      const r = parseClaudeUsageScreen(week(good), NOW);
      expect(r.ok && r.buckets[0]!.windows[1]!.usedPercent, good).toBe(value);
    }
  });

  it("anything unrecognised is refused, never guessed", () => {
    expect(parseClaudeUsageScreen("Something else entirely", NOW)).toEqual({ ok: false, detail: "no Current week (all models) on the /usage screen" });
    expect(parseClaudeUsageScreen(usageScreen({ weekReset: "next Tuesday" }), NOW)).toMatchObject({ ok: false, detail: expect.stringContaining("unrecognized reset text") });
    expect(parseClaudeUsageScreen(usageScreen({ week: 140 }), NOW)).toMatchObject({ ok: false, detail: expect.stringContaining("out of range") });
    expect(parseClaudeUsageScreen(" Current week (all models)\n Resets 3pm (UTC)", NOW)).toMatchObject({ ok: false, detail: expect.stringContaining("% used") });
  });
});

describe("Claude identity: the organisation and the email, both required", () => {
  const answer = (orgId: string | null, email: string | null = "d***@example.test"): ClaudeUsageAnswer & { observedAt: string } =>
    ({ auth: { loggedIn: true, authMethod: "claude.ai", email, orgId, orgName: "Example Org", subscriptionType: "team" }, screen: usageScreen(), observedAt: NOW });

  it("keys by orgId, email and bucket; organisation name and subscription are labels; either missing is unresolved", () => {
    const r = normalizeClaudeUsage(answer("org-1"));
    expect(r.ok && r.readings[0]!.identity).toEqual({
      orgId: "org-1", limitId: "all models", email: "d***@example.test", orgName: "Example Org", subscriptionType: "team", source: "claude auth status orgId and email",
    });
    for (const [orgId, email] of [[null, "d***@example.test"], ["org-1", null]] as const) {
      const u = normalizeClaudeUsage(answer(orgId, email));
      expect(u.ok && u.readings[0]!.identity.source, `${orgId} ${email}`).toBe("unresolved");
    }
  });

  it("two members of one organisation are two rows; switching between them never relabels a row", async () => {
    const reads: Array<[string, number]> = [["a***@example.test", 90], ["b***@example.test", 10], ["a***@example.test", 95]];
    let n = 0;
    const windows = new ClaudeUsageWindows({
      now: () => NOW,
      read: async () => {
        const [email, week] = reads[n]!;
        return { ok: true, observedAt: at(n++), auth: answer("org-1", email).auth, screen: usageScreen({ week }) };
      },
    });
    await windows.refresh();
    await windows.refresh();
    const afterB = windows.project(at(3));
    expect(afterB.map((r) => [(r.identity as { email: string }).email, r.windows[1]!.usedPercent, r.latestFromSource])).toEqual([
      ["a***@example.test", 90, false],
      ["b***@example.test", 10, true],
    ]);
    await windows.refresh();
    const afterA = windows.project(at(3));
    expect(afterA.map((r) => [(r.identity as { email: string }).email, r.windows[1]!.usedPercent, r.latestFromSource])).toEqual([
      ["a***@example.test", 95, true],
      ["b***@example.test", 10, false],
    ]);
    expect(afterA[1]!.windows.every((w) => w.freshness === "stale")).toBe(true);
  });

  it("the same email under another organisation is another row", async () => {
    const outcomes: Array<UsageReadOutcome<ClaudeUsageAnswer>> = [
      { ok: true, observedAt: NOW, auth: answer("org-1").auth, screen: usageScreen({ week: 100 }) },
      { ok: true, observedAt: at(1), auth: answer("org-2").auth, screen: usageScreen({ week: 10 }) },
    ];
    let n = 0;
    const windows = new ClaudeUsageWindows({ now: () => NOW, read: async () => outcomes[n++]! });
    await windows.refresh();
    await windows.refresh();
    const rows = windows.project(at(2));
    expect(rows.map((r) => [(r.identity as { orgId: string }).orgId, r.windows[1]!.level, r.latestFromSource])).toEqual([
      ["org-1", "exhausted", false],
      ["org-2", "ok", true],
    ]);
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

  it("an earlier unresolved row can't read fresh, and says it may be this same login", async () => {
    const auth = { loggedIn: true, authMethod: "claude.ai", email: "d***@example.test", orgId: null, orgName: null, subscriptionType: null };
    let n = 0;
    const windows = new ClaudeUsageWindows({ now: () => NOW, read: async () => ({ ok: true, observedAt: at(n++), auth, screen: usageScreen() }) });
    await windows.refresh();
    await windows.refresh();
    const [earlier, latest] = windows.project(at(2));
    expect(earlier!.windows.every((w) => w.freshness === "stale" && w.freshnessReason === "a later read exists")).toBe(true);
    expect(earlier!.unresolved!.note).toBe("identity unresolved: from an earlier read, possibly this same login; not matched to, merged with or replacing any other row");
    expect(latest!.windows.every((w) => w.freshness === "fresh")).toBe(true);
  });
});

describe("claudeUsageReader against a fake claude in a private tmux server", () => {
  const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "claude-reader-home-"));
  // This file's readers make their private tmux dirs under their own root, so other test files reading
  // Claude at the same time can't change what these cleanup assertions see.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-reader-root-"));
  const reader = (fake: ReturnType<typeof makeFakeClaude>, deadlineMs = 8_000, launchPath = `${fake.binDir}${path.delimiter}${process.env.PATH}`) =>
    claudeUsageReader({ launchPath, home: home(), claudeConfigDir: fake.configDir, deadlineMs, pollMs: 100, tmpRoot });
  const ownDirs = () => fs.readdirSync(tmpRoot).filter((d) => d.startsWith("openrig-claude-usage-")).sort();

  it("reads identity and the screen; starts Claude safe-mode on /usage with the no-model guard; types only exit keys", async () => {
    const fake = makeFakeClaude();
    fake.setPlan({ auth: [CLAUDE_AUTH], screen: usageScreen() });
    const before = ownDirs();
    const r = await reader(fake)();
    expect(r).toMatchObject({ ok: true, auth: { loggedIn: true, authMethod: "claude.ai", email: "d***@example.test", orgId: "org-1", orgName: "Example Org", subscriptionType: "team" } });
    expect(r.ok && r.screen).toContain("Current week (all models)");
    expect(fake.authCalls()).toBe(2); // before and after the screen
    const [start] = fake.screenStarts();
    expect(start!.argv).toEqual(["--safe-mode", "--strict-mcp-config", "--tools", "", "--model", CLAUDE_USAGE_NO_MODEL, "/usage"]);
    expect(start!.env).toMatchObject({ TMUX: null, TMUX_PANE: null, OPENRIG_SESSION_NAME: null, CLAUDECODE: null, TZ: "UTC" });
    // Esc, Ctrl-C, Ctrl-C and nothing else.
    expect(fake.keys()).toBe("1b0303");
    expect(ownDirs()).toEqual(before); // private server's temp dir removed
  });

  it("a tmux that rewrites the pane's PATH still starts the resolved claude, never another one", async () => {
    const fake = makeFakeClaude();
    fake.setPlan({ auth: [CLAUDE_AUTH], screen: usageScreen() });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-reader-wrapper-"));
    const trip = path.join(root, "trip");
    const wrap = path.join(root, "wrap");
    fs.mkdirSync(trip);
    fs.mkdirSync(wrap);
    const tripped = path.join(root, "TRIPPED");
    fs.writeFileSync(path.join(trip, "claude"), `#!/bin/sh\necho reached > ${tripped}\nexit 99\n`, { mode: 0o755 });
    const realTmux = execFileSync("sh", ["-c", "command -v tmux"]).toString().trim();
    // Like the repo scaffold's wrapper: real tmux, with PATH reset to one where another claude comes first.
    fs.writeFileSync(path.join(wrap, "tmux"), `#!/bin/sh\nPATH=${trip}:$PATH exec ${realTmux} "$@"\n`, { mode: 0o755 });
    const r = await claudeUsageReader({ launchPath: [wrap, fake.binDir, process.env.PATH].join(path.delimiter), home: home(), claudeConfigDir: fake.configDir, deadlineMs: 8_000, pollMs: 100 })();
    expect(r).toMatchObject({ ok: true });
    expect(fs.existsSync(tripped)).toBe(false);
    expect(fake.screenStarts()).toHaveLength(1);
  });

  it("no claude on the reader's PATH fails before anything starts", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "claude-reader-nobin-"));
    const r = await claudeUsageReader({ launchPath: empty, home: home(), deadlineMs: 2_000 })();
    expect(r).toMatchObject({ ok: false, reason: "binary_not_found", detail: "no claude executable on the daemon's PATH" });
  });

  it("the private tmux dir is made under tmpRoot while a read runs, and removed after", async () => {
    const fake = makeFakeClaude();
    fake.setPlan({ auth: [CLAUDE_AUTH], screen: "hang" });
    const running = reader(fake, 1_500)();
    await new Promise((r) => setTimeout(r, 700));
    expect(ownDirs()).toHaveLength(1);
    expect(await running).toMatchObject({ ok: false, reason: "timeout" });
    expect(ownDirs()).toEqual([]);
  });

  it("an early exit says honestly what it may mean (no version probe)", async () => {
    const fake = makeFakeClaude();
    fake.setPlan({ auth: [CLAUDE_AUTH], screen: "exit" });
    expect(await reader(fake)()).toMatchObject({ ok: false, reason: "child_exited",
      detail: "claude exited before the usage screen rendered (a Claude Code without these flags, such as --safe-mode, exits this way)" });
  });

  it("a logged-out or API-key login is refused before the screen starts", async () => {
    const fake = makeFakeClaude();
    fake.setPlan({ auth: [{ loggedIn: false }], screen: usageScreen() });
    expect(await reader(fake)()).toMatchObject({ ok: false, reason: "not_logged_in" });
    fake.setPlan({ auth: [{ ...CLAUDE_AUTH, authMethod: "api_key" }], screen: usageScreen() });
    expect(await reader(fake)()).toMatchObject({ ok: false, reason: "not_subscription_login" });
    expect(fake.screenStarts()).toEqual([]);
  });

  it("failure reasons: prompt, failed load, child exit, timeout, identity change, auth failures, missing binaries", async () => {
    const fake = makeFakeClaude();
    const cases: Array<[string, Parameters<typeof fake.setPlan>[0], string]> = [
      ["trust prompt", { auth: [CLAUDE_AUTH], screen: " Do you trust the files in this folder?\n 1. Yes, proceed" }, "interaction_required"],
      ["failed load", { auth: [CLAUDE_AUTH], screen: " Failed to load usage data" }, "usage_unavailable"],
      ["child exit", { auth: [CLAUDE_AUTH], screen: "exit" }, "child_exited"],
      ["hang", { auth: [CLAUDE_AUTH], screen: "hang" }, "timeout"],
      ["identity change", { auth: [CLAUDE_AUTH, { ...CLAUDE_AUTH, orgId: "org-2" }], screen: usageScreen() }, "identity_changed_during_read"],
      ["recheck failure", { auth: [CLAUDE_AUTH, null], screen: usageScreen() }, "identity_recheck_failed"],
      ["auth failure", { auth: [null], screen: usageScreen() }, "auth_status_failed"],
    ];
    const before = ownDirs();
    for (const [name, plan, reason] of cases) {
      fake.setPlan(plan);
      expect(await reader(fake, 2_000)(), name).toMatchObject({ ok: false, reason });
    }
    // Every keystroke the screens received was an exit key.
    expect(fake.keys()).toMatch(/^(1b|03)*$/);
    expect(ownDirs()).toEqual(before);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "claude-reader-nobin-"));
    expect(await reader(fake, 2_000, empty)()).toMatchObject({ ok: false, reason: "binary_not_found" });
    fake.setPlan({ auth: [CLAUDE_AUTH], screen: usageScreen() });
    expect(await reader(fake, 2_000, fake.binDir)()).toMatchObject({ ok: false, reason: "tmux_unavailable" });
  }, 60_000);

  it("auth facts come only from a command that succeeded: valid JSON with exit 9 fails, first or after, and the older reading is kept", async () => {
    const fake = makeFakeClaude();
    fake.setPlan({ auth: [CLAUDE_AUTH], authExit: [9], screen: usageScreen() });
    expect(await reader(fake, 4_000)()).toMatchObject({ ok: false, reason: "auth_status_failed", detail: "claude auth status failed (exit 9)" });
    expect(fake.screenStarts()).toEqual([]);
    fake.setPlan({ auth: [CLAUDE_AUTH], authExit: [0, 9], screen: usageScreen() });
    expect(await reader(fake, 4_000)()).toMatchObject({ ok: false, reason: "identity_recheck_failed", detail: expect.stringContaining("(exit 9)") });

    const windows = new ClaudeUsageWindows({ read: reader(fake, 4_000) });
    fake.setPlan({ auth: [CLAUDE_AUTH], screen: usageScreen({ week: 41 }) });
    expect((await windows.refresh()).refresh).toMatchObject({ outcome: "ok" });
    fake.setPlan({ auth: [CLAUDE_AUTH], authExit: [9], screen: usageScreen({ week: 99 }) });
    expect((await windows.refresh()).refresh).toMatchObject({ outcome: "failed", reason: "auth_status_failed" });
    const [row] = windows.project(new Date().toISOString());
    expect(row!.windows[1]!.usedPercent).toBe(41);
    expect(row!.windows.every((w) => w.freshness === "stale")).toBe(true);
  }, 30_000);

  it("nothing a read started survives it: auth timeout, screen failure, timeout and success, with processes that ignore HUP and TERM", async () => {
    const fake = makeFakeClaude();
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const groupAlive = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
    const cases: Array<[string, Parameters<typeof fake.setPlan>[0], string, number]> = [
      ["auth timeout", { auth: ["hang"], screen: usageScreen(), stubborn: true }, "auth_status_failed", 1],
      ["screen failure", { auth: [CLAUDE_AUTH], screen: "exit", stubborn: true }, "child_exited", 2],
      ["timeout", { auth: [CLAUDE_AUTH], screen: "hang", stubborn: true }, "timeout", 2],
      ["success", { auth: [CLAUDE_AUTH], screen: usageScreen(), stubborn: true }, "ok", 3],
    ];
    const before = ownDirs();
    for (const [name, plan, outcome, starts] of cases) {
      fake.setPlan(plan);
      const r = await claudeUsageReader({ launchPath: `${fake.binDir}${path.delimiter}${process.env.PATH}`, home: home(), claudeConfigDir: fake.configDir,
        deadlineMs: outcome === "timeout" || outcome === "auth_status_failed" ? 3_000 : 10_000, pollMs: 100, tmpRoot, graceMs: 500 })();
      expect(r.ok ? "ok" : r.reason, name).toBe(outcome);
      const procs = fake.procs();
      expect(procs, name).toHaveLength(starts);
      for (const p of procs) {
        expect(p.pids.filter(alive), `${name}: ${p.what} pids`).toEqual([]);
        expect(groupAlive(p.pgid), `${name}: ${p.what} group`).toBe(false);
      }
    }
    expect(ownDirs()).toEqual(before);
  }, 60_000);

  it("a trust prompt names the folder and how a person clears it", async () => {
    const fake = makeFakeClaude();
    fake.setPlan({ auth: [CLAUDE_AUTH], screen: " Do you trust the files in this folder?\n 1. Yes, proceed" });
    const r = await reader(fake, 4_000)();
    expect(r).toMatchObject({ ok: false, reason: "interaction_required" });
    expect(!r.ok && r.detail).toMatch(/^claude asked whether to trust the folder it runs in \(.*claude-reader-home-.*\), the daemon's HOME; nothing was answered\. Every read stops here until that folder is trusted: start claude there once as this login and accept the trust prompt$/);
  });

  it("a rendered but unrecognised screen reaches the cache as unrecognized_shape", async () => {
    const fake = makeFakeClaude();
    fake.setPlan({ auth: [CLAUDE_AUTH], screen: usageScreen({ weekReset: "next Tuesday" }) });
    const windows = new ClaudeUsageWindows({ read: reader(fake) });
    expect((await windows.refresh()).refresh).toMatchObject({ outcome: "failed", reason: "unrecognized_shape" });
  });

  it("the child environment drops TMUX, TMUX_PANE and seat variables, and keeps the config dir", () => {
    const env = claudeUsageReaderEnv({ launchPath: "/p", home: "/h", claudeConfigDir: "/c" },
      { TMUX: "x", TMUX_PANE: "%1", OPENRIG_SESSION_NAME: "s@r", RIGGED_X: "1", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", KEEP: "k" });
    expect(env).toEqual({ KEEP: "k", PATH: "/p", HOME: "/h", CLAUDE_CONFIG_DIR: "/c", TZ: "UTC", DISABLE_AUTOUPDATER: "1", TERM: "xterm-256color" });
  });
});
