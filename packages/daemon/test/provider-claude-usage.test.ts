// Slice 01 (OPR.0.7.0.1) — Claude usage windows: the `/usage` screen parser, the identity rule, the
// reader in its private tmux server against a fake `claude`, and LOW-4 (superseded rows age to stale).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

  it("anything unrecognised is refused, never guessed", () => {
    expect(parseClaudeUsageScreen("Something else entirely", NOW)).toEqual({ ok: false, detail: "no Current week (all models) on the /usage screen" });
    expect(parseClaudeUsageScreen(usageScreen({ weekReset: "next Tuesday" }), NOW)).toMatchObject({ ok: false, detail: expect.stringContaining("unrecognized reset text") });
    expect(parseClaudeUsageScreen(usageScreen({ week: 140 }), NOW)).toMatchObject({ ok: false, detail: expect.stringContaining("out of range") });
    expect(parseClaudeUsageScreen(" Current week (all models)\n Resets 3pm (UTC)", NOW)).toMatchObject({ ok: false, detail: expect.stringContaining("% used") });
  });
});

describe("Claude identity: the organisation, never email alone", () => {
  const answer = (orgId: string | null, email = "d***@example.test"): ClaudeUsageAnswer & { observedAt: string } =>
    ({ auth: { loggedIn: true, authMethod: "claude.ai", email, orgId }, screen: usageScreen(), observedAt: NOW });

  it("keys by orgId and bucket; email is a label; no orgId is unresolved", () => {
    const r = normalizeClaudeUsage(answer("org-1"));
    expect(r.ok && r.readings[0]!.identity).toEqual({ orgId: "org-1", limitId: "all models", email: "d***@example.test", source: "claude auth status orgId" });
    const u = normalizeClaudeUsage(answer(null));
    expect(u.ok && u.readings[0]!.identity.source).toBe("unresolved");
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
    const auth = { loggedIn: true, authMethod: "claude.ai", email: "d***@example.test", orgId: null };
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
  const reader = (fake: ReturnType<typeof makeFakeClaude>, deadlineMs = 8_000, launchPath = `${fake.binDir}${path.delimiter}${process.env.PATH}`) =>
    claudeUsageReader({ launchPath, home: home(), claudeConfigDir: fake.configDir, deadlineMs, pollMs: 100 });
  const ownDirs = () => fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("openrig-claude-usage-")).sort();

  it("reads identity and the screen; starts Claude safe-mode on /usage with the no-model guard; types only exit keys", async () => {
    const fake = makeFakeClaude();
    fake.setPlan({ auth: [CLAUDE_AUTH], screen: usageScreen() });
    const before = ownDirs();
    const r = await reader(fake)();
    expect(r).toMatchObject({ ok: true, auth: { loggedIn: true, authMethod: "claude.ai", email: "d***@example.test", orgId: "org-1" } });
    expect(r.ok && r.screen).toContain("Current week (all models)");
    expect(fake.authCalls()).toBe(2); // before and after the screen
    const [start] = fake.screenStarts();
    expect(start!.argv).toEqual(["--safe-mode", "--strict-mcp-config", "--tools", "", "--model", CLAUDE_USAGE_NO_MODEL, "/usage"]);
    expect(start!.env).toMatchObject({ TMUX: null, TMUX_PANE: null, OPENRIG_SESSION_NAME: null, CLAUDECODE: null, TZ: "UTC" });
    // Esc, Ctrl-C, Ctrl-C and nothing else.
    expect(fake.keys()).toBe("1b0303");
    expect(ownDirs()).toEqual(before); // private server's temp dir removed
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
