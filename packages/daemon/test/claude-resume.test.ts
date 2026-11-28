import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import type { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import type { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";

const CLAUDE_FLOOR_EFFECT = {
  runtime: "claude-code",
  axis: "permission",
  state: "observed",
  value: "acceptEdits",
  reason: "emitted_launch_arguments",
  claudeAutoMode: null,
} as const;

// A staged launch's script name, and the exact line typed to run it, which the pane shows once its shell reads it.
const launchName = "openrig-tmux-send-4242-0f0e0d0c-1111-4222-8333-444455556666.txt";
const typedLaunch = `( . '/tmp/${launchName}' )`;

const DRAWN_CLAUDE = `Claude Code v2.1.310\n${"─".repeat(60)}\n❯ \n${"─".repeat(60)}\n  ⏵⏵ accept edits on (shift+tab to cycle)`;

function mockTmux(overrides?: {
  sendText?: (target: string, text: string) => Promise<TmuxResult>;
  sendKeys?: (target: string, keys: string[]) => Promise<TmuxResult>;
  getPaneCommand?: (target: string) => Promise<string | null>;
  capturePaneContent?: (target: string, lines?: number) => Promise<string | null>;
  getPanePid?: (target: string) => Promise<number | null>;
}) {
  return {
    sendText: overrides?.sendText ?? vi.fn(async () => ({ ok: true as const })),
    sendKeys: overrides?.sendKeys ?? vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: overrides?.getPaneCommand ?? vi.fn(async () => "claude"),
    // A resumed Claude's drawn screen: Claude's process alone, with nothing drawn, only stands when the wait runs out.
    capturePaneContent: overrides?.capturePaneContent ?? vi.fn(async () => DRAWN_CLAUDE),
    getPanePid: overrides?.getPanePid ?? vi.fn(async () => null),
    setSessionEnv: vi.fn(async () => {}),
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    hasSession: async () => false,
  } as unknown as TmuxAdapter;
}

describe("ClaudeResumeAdapter", () => {
  it("delivers oversized composed settings by file when restoring a Claude seat", async () => {
    const tmux = mockTmux();
    const openrigHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-settings-"));
    const adapter = new ClaudeResumeAdapter(tmux, { openrigHome, maxWaitMs: 1, sleep: async () => {} });
    const args: Parameters<ClaudeResumeAdapter["resume"]> = ["seat@rig", "claude_id", "previous", "/repo"];
    args[14] = { deny: Array.from({ length: 2000 }, (_, i) => `Read(/example/restricted/${i}/${"x".repeat(70)}/**)`) };
    const result = await adapter.resume(...args);
    try {
      const file = /--settings'? '([^']+\.json)'/.exec(vi.mocked(tmux.sendText).mock.calls[0]?.[1] ?? "")?.[1];
      expect(file, JSON.stringify(result)).toBeDefined();
      expect(JSON.parse(fs.readFileSync(file!, "utf8")).permissions.deny).toEqual(args[14]!.deny);
    } finally { fs.rmSync(openrigHome, { recursive: true, force: true }); }
  });

  it("checks the captured settings actually sent by a provider restore", async () => {
    const tmux = mockTmux();
    const openrigHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-settings-"));
    const adapter = new ClaudeResumeAdapter(tmux, { openrigHome, maxWaitMs: 1, sleep: async () => {} });
    const args: Parameters<ClaudeResumeAdapter["resume"]> = ["seat@rig", "claude_id", "previous", "/repo"];
    args[16] = "/native/claude";
    args[19] = { args: ["--settings", JSON.stringify({ custom: "x".repeat(131072) })], warnings: [] };
    const result = await adapter.resume(...args);
    try {
      const file = /--settings' '([^']+\.json)'/.exec(vi.mocked(tmux.sendText).mock.calls[0]?.[1] ?? "")?.[1];
      expect(file, JSON.stringify(result)).toBeDefined();
      expect(JSON.parse(fs.readFileSync(file!, "utf8"))).toEqual({ custom: "x".repeat(131072) });
    } finally { fs.rmSync(openrigHome, { recursive: true, force: true }); }
  });

  it("warning-only capture on a classic resume still dispatches the ordinary command", async () => {
    const tmux = mockTmux();
    const adapter = new ClaudeResumeAdapter(tmux, { maxWaitMs: 1, sleep: async () => {} });
    await adapter.resume("seat@rig", "claude_id", "same", "/repo", "floor", undefined, undefined, "node",
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "/native/claude", undefined, undefined,
      { warnings: ["capture unavailable"] });
    expect(tmux.sendText).toHaveBeenCalledWith("seat@rig", expect.stringContaining("--permission-mode acceptEdits"));
    expect(tmux.sendText).toHaveBeenCalledWith("seat@rig", expect.stringContaining("--resume 'same'"));
  });

  it("an in-place provider continuation keeps custom settings, config dir and model", async () => {
    const tmux = mockTmux();
    tmux.sendShellCommand = vi.fn(async () => ({ ok: true as const }));
    const nativeCommand = vi.fn(() => "retained-launch");
    const prepare = vi.fn(async () => ({ command: nativeCommand, warnings: [], assertCurrent: () => {} }));
    const adapter = new ClaudeResumeAdapter(tmux, { claudeManagedLaunch: { prepare } as unknown as ClaudeManagedLaunch });
    const launch = { args: ["--settings", "/custom rules/settings.json", "--model", "opus", "--permission-mode", "auto", "--name", "seat@rig"],
      configDir: "/custom config", warnings: [] };
    await adapter.resume("seat@rig", "claude_id", "same-conversation", "/repo", "auto", "sonnet", "auto", "node",
      "high", undefined, undefined, undefined, undefined, undefined, undefined, undefined, "/native/claude", undefined, undefined, launch);
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ continuationConfigDir: launch.configDir }), "auto");
    expect(nativeCommand).toHaveBeenCalledWith(["--settings", "/custom rules/settings.json", "--model", "opus", "--name", "seat@rig", "--effort", "high", "--permission-mode", "auto", "--resume", "same-conversation"], { OPENRIG_RESUME_LAUNCH: "same-conversation" });
    expect(tmux.sendShellCommand).toHaveBeenCalledTimes(1);
  });

  describe("a continuation from captured arguments sends and records the seat's current auto mode block", () => {
    const running = { permissions: { allow: ["Read(/a b)"] }, autoMode: { environment: ["$defaults", "Running A"] } };
    const saved = { environment: ["$defaults", "Saved B"] };
    const resumeWith = async (block: unknown, args = ["--settings", JSON.stringify(running), "--model", "opus"]) => {
      const tmux = mockTmux();
      tmux.sendShellCommand = vi.fn(async () => ({ ok: true as const }));
      const nativeCommand = vi.fn((_args: string[]) => "retained-launch");
      const prepare = vi.fn(async () => ({ command: nativeCommand, warnings: [], assertCurrent: () => {} }));
      const adapter = new ClaudeResumeAdapter(tmux, { claudeManagedLaunch: { prepare } as unknown as ClaudeManagedLaunch });
      const result = await adapter.resume("seat@rig", "claude_id", "same", "/repo", "auto", undefined, "auto", "node",
        ...Array(8).fill(undefined), "/native/claude", undefined, undefined, { args, configDir: null, warnings: [] }, block as never);
      const sent = nativeCommand.mock.calls[0]![0];
      const value = sent.includes("--settings") ? sent[sent.indexOf("--settings") + 1]! : undefined;
      return { result, sent, settings: value?.startsWith("{") ? JSON.parse(value) : value };
    };

    it("replaces the running block with the saved one and keeps the other settings", async () => {
      const { result, settings } = await resumeWith(saved);
      expect(settings).toEqual({ permissions: running.permissions, autoMode: saved });
      expect(result).toMatchObject({ ok: true, appliedLaunch: { claudeAutoMode: saved } });
    });

    it("drops the running block after a clear and records that none was sent", async () => {
      const { result, settings } = await resumeWith(undefined);
      expect(settings).toEqual({ permissions: running.permissions });
      expect(result).toMatchObject({ ok: true, appliedLaunch: { claudeAutoMode: null } });
    });

    it("drops the running block when the saved one can't be read, and warns", async () => {
      const unreadable = "Seat n1: the saved claude_auto_mode can't be read (broken), so launches don't send it.";
      const { result, settings } = await resumeWith({ unreadable });
      expect(settings).toEqual({ permissions: running.permissions });
      expect(result).toMatchObject({ ok: true, warnings: expect.arrayContaining([unreadable]), appliedLaunch: { claudeAutoMode: null } });
    });

    it("adds the saved block when the running process had no settings", async () => {
      const { result, settings } = await resumeWith(saved, ["--model", "opus"]);
      expect(settings).toEqual({ autoMode: saved });
      expect(result).toMatchObject({ ok: true, appliedLaunch: { claudeAutoMode: saved } });
    });

    it.each([["a saved block", saved], ["no saved block", undefined]])("records unknown when the running settings are a file, with %s", async (_label, block) => {
      const { result, sent } = await resumeWith(block, ["--settings", "/custom/settings.json", "--model", "opus"]);
      expect(sent).toContain("/custom/settings.json");
      expect(result).toMatchObject({ ok: true, warnings: expect.arrayContaining([expect.stringContaining("can't set or check its auto mode block")]),
        appliedLaunch: { claudeAutoMode: { unknown: "settings_file" } } });
    });
  });

  it.each([false, true])("carries the retained executable and wrapper through restore preparation (managed: %s)", async managed => {
    const tmux = mockTmux();
    tmux.sendShellCommand = vi.fn(async () => ({ ok: true as const }));
    const command = vi.fn(async (_session: string, text: string, _options: unknown) => text);
    const prepare = vi.fn(async (_input: unknown, _mode: string) => ({ command: () => "managed-resume", warnings: [] }));
    const adapter = new ClaudeResumeAdapter(tmux, {
      seatLaunchEnvironment: { command, resolveLaunchWrapper: () => wrapper } as unknown as SeatLaunchEnvironment,
      ...(managed ? { claudeManagedLaunch: { prepare } as unknown as ClaudeManagedLaunch } : {}),
    });
    const wrapper = ["/wrapper", "--"];
    await adapter.resume("seat@rig", "claude_id", "original", "/repo", "floor", undefined, managed ? "acceptEdits" : undefined, "node",
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "/native tools/claude", undefined, wrapper, undefined, undefined, "successor-generation");

    if (managed) {
      expect(prepare).toHaveBeenCalledWith({ nodeId: "node", cwd: "/repo", session: "seat@rig", executable: "/native tools/claude", launchWrapper: wrapper, generation: "successor-generation" }, "acceptEdits");
      expect(command).not.toHaveBeenCalled();
    } else {
      expect(command).toHaveBeenCalledWith("seat@rig", expect.stringContaining("exec '/wrapper' '--' '/native tools/claude'"), {
        runtime: "claude-code", nodeId: "node", generation: "successor-generation", launchWrapper: wrapper, claudeShellLookup: false,
      });
      expect(prepare).not.toHaveBeenCalled();
    }
    expect(tmux.sendShellCommand).toHaveBeenCalledOnce();
    expect(tmux.setSessionEnv).toHaveBeenCalledWith("seat@rig", "OPENRIG_OCCUPANT_GENERATION", "successor-generation");
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it.each([false, true])("refuses API resume when the token step cannot run (environment present: %s)", async (hasEnvironment) => {
    const tmux = mockTmux();
    tmux.sendShellCommand = vi.fn(async () => ({ ok: true as const }));
    const adapter = new ClaudeResumeAdapter(tmux, {
      claudeManagedLaunch: { seatTokenLaunch: () => ({
        ref: { label: "api", tokenFile: "/synthetic/api-key", kind: "api-key" },
        step: "synthetic-token-step", warnings: [],
      }) } as unknown as ClaudeManagedLaunch,
      ...(hasEnvironment ? { seatLaunchEnvironment: {
        command: async (_session: string, command: string) => command,
      } as unknown as SeatLaunchEnvironment } : {}),
    });
    const result = await adapter.resume("seat@rig", "claude_id", "original", "/repo", "floor", "haiku", undefined, "node");
    expect(result).toMatchObject({ ok: false, code: "resume_failed", message: expect.stringContaining("no Claude process started") });
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(tmux.sendShellCommand).not.toHaveBeenCalled();
    expect(tmux.sendKeys).not.toHaveBeenCalled();
  });

  it("the legacy continuation uses the retained executable and original conversation", async () => {
    const tmux = mockTmux();
    const adapter = new ClaudeResumeAdapter(tmux, { maxWaitMs: 1, sleep: async () => {} });
    await adapter.resume("seat@rig", "claude_id", "original", "/repo", undefined, undefined, undefined, "node",
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "/native tools/claude");
    expect(tmux.sendText).toHaveBeenCalledWith("seat@rig", expect.stringContaining("exec '/native tools/claude'"));
    expect(tmux.sendText).toHaveBeenCalledWith("seat@rig", expect.stringContaining("--resume 'original'"));
  });

  describe("canResume", () => {
    it("claude_name + token -> true", () => {
      const adapter = new ClaudeResumeAdapter(mockTmux());
      expect(adapter.canResume("claude_name", "my-session")).toBe(true);
    });

    it("claude_id + token -> true", () => {
      const adapter = new ClaudeResumeAdapter(mockTmux());
      expect(adapter.canResume("claude_id", "abc-123")).toBe(true);
    });

    it("no token -> false", () => {
      const adapter = new ClaudeResumeAdapter(mockTmux());
      expect(adapter.canResume("claude_name", null)).toBe(false);
    });

    it("resume_type=none -> false", () => {
      const adapter = new ClaudeResumeAdapter(mockTmux());
      expect(adapter.canResume("none", "token")).toBe(false);
    });

    it("codex_id -> false (cross-harness)", () => {
      const adapter = new ClaudeResumeAdapter(mockTmux());
      expect(adapter.canResume("codex_id", "token")).toBe(false);
    });
  });

  describe("resume", () => {
    it("sends sendText then sendKeys Enter", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({ sendText, sendKeys });
      const adapter = new ClaudeResumeAdapter(tmux);

      await adapter.resume("r99-demo1-lead", "claude_name", "my-session", "/repo");

      expect(sendText).toHaveBeenCalledOnce();
      expect(sendText.mock.calls[0]![0]).toBe("r99-demo1-lead");
      // OPR.0.4.8.2: restore now carries the launch-posture floor (acceptEdits), same as fresh.
      expect(sendText.mock.calls[0]![1]).toBe("OPENRIG_RESUME_LAUNCH='my-session' CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 claude --permission-mode acceptEdits --resume 'my-session'");
      expect(sendKeys).toHaveBeenCalledOnce();
      expect(sendKeys.mock.calls[0]![0]).toBe("r99-demo1-lead");
      expect(sendKeys.mock.calls[0]![1]).toEqual(["Enter"]);
      // sendText called before sendKeys
      expect(sendText.mock.invocationCallOrder[0]).toBeLessThan(sendKeys.mock.invocationCallOrder[0]!);
    });

    it("0.5.2-07: a SPEC-pinned model emits --model on the legacy resume command", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({ sendText });
      const adapter = new ClaudeResumeAdapter(tmux);

      await adapter.resume("r99-demo1-lead", "claude_name", "my-session", "/repo", undefined, "gpt-5.4-cheap");

      expect(sendText.mock.calls[0]![1]).toBe(
        "OPENRIG_RESUME_LAUNCH='my-session' CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 claude --permission-mode acceptEdits --model 'gpt-5.4-cheap' --resume 'my-session'"
      );
    });

    it("#75: a SPEC-pinned effort emits --effort on the legacy resume command", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({ sendText });
      const adapter = new ClaudeResumeAdapter(tmux);

      await adapter.resume("r99-demo1-lead", "claude_name", "my-session", "/repo", undefined, "gpt-5.4-cheap", undefined, undefined, "high");

      expect(sendText.mock.calls[0]![1]).toBe(
        "OPENRIG_RESUME_LAUNCH='my-session' CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 claude --permission-mode acceptEdits --model 'gpt-5.4-cheap' --effort 'high' --resume 'my-session'"
      );
    });
    it("OPR.0.7.0.9: a seat's launch additions reach the restore resume command after its Advisor, before --resume", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({ sendText });
      const adapter = new ClaudeResumeAdapter(tmux);

      await adapter.resume("r99-demo1-lead", "claude_name", "my-session", "/repo", undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, "opus", { agent: "openrig:reviewer", appendSystemPromptFile: "/seat root/additions/system-prompt.md", pluginDirs: [] });

      expect(sendText.mock.calls[0]![1]).toBe(
        "OPENRIG_RESUME_LAUNCH='my-session' CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 claude --permission-mode acceptEdits --advisor 'opus' --agent 'openrig:reviewer' --append-system-prompt-file '/seat root/additions/system-prompt.md' --resume 'my-session'"
      );
    });

    it("keeps member rules when a classic resume applies the seat's own subscription token", async () => {
      const step = "fixture-seat-token-step";
      const sendShellCommand = vi.fn(async (_target: string, _command: string) => ({ ok: true as const }));
      const command = vi.fn(async (_target: string, text: string, options: { claudeTokenStep?: string }) => `${options.claudeTokenStep}; ${text}`);
      const adapter = new ClaudeResumeAdapter({ ...mockTmux(), sendShellCommand }, {
        claudeManagedLaunch: { seatTokenLaunch: () => ({ step, ref: { label: "work", tokenFile: "/fixture/work.token" }, warnings: ["fixture token warning"] }) } as never,
        seatLaunchEnvironment: { command } as never,
      });
      const result = await adapter.resume("seat@rig", "claude_id", "conversation", "/repo", undefined, undefined, undefined, "node",
        undefined, undefined, undefined, undefined, undefined, undefined, { deny: ["Read(../peer/**)"] });
      expect(result).toMatchObject({ ok: true, warnings: ["fixture token warning"] });
      expect(command.mock.calls[0]![2].claudeTokenStep).toBe(step);
      expect(sendShellCommand).toHaveBeenCalledTimes(1);
      const launch = sendShellCommand.mock.calls[0]![1];
      expect(launch).toContain(step);
      expect(launch).toContain('"deny":["Read(../peer/**)"]');
      expect(launch).toContain("--resume 'conversation'");
    });

    it("composes the seat's auto mode block into the resume's --settings and records it as applied", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const adapter = new ClaudeResumeAdapter(mockTmux({ sendText }));
      const block = { environment: ["$defaults", "Source control: github.com/acme's org"] };
      const result = await adapter.resume("seat@rig", "claude_id", "conversation", "/repo", "auto", undefined, undefined, "node",
        ...Array(12).fill(undefined), block);
      expect(result).toMatchObject({ ok: true, appliedLaunch: { value: "auto", claudeAutoMode: block } });
      const launch = String(sendText.mock.calls[0]![1]);
      expect(launch).toContain("--permission-mode auto");
      expect(launch.replace(/'"'"'/g, "'")).toContain(`"autoMode":${JSON.stringify(block)}`);
    });

    it("resumes without a saved block that can't be read, warns, and records that none was sent", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const adapter = new ClaudeResumeAdapter(mockTmux({ sendText }));
      const unreadable = "Seat n1: the saved claude_auto_mode can't be read (broken), so launches don't send it.";
      const result = await adapter.resume("seat@rig", "claude_id", "conversation", "/repo", "auto", undefined, undefined, "node",
        ...Array(12).fill(undefined), { unreadable });
      expect(result).toMatchObject({ ok: true, warnings: [unreadable], appliedLaunch: { claudeAutoMode: null } });
      expect(String(sendText.mock.calls[0]![1])).not.toContain("autoMode");
    });

    it("composes member rules and the auto mode block into one --settings on resume", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const adapter = new ClaudeResumeAdapter(mockTmux({ sendText }));
      const block = { soft_deny: ["$defaults", "Pushing to main"] };
      await adapter.resume("seat@rig", "claude_id", "conversation", "/repo", "auto", undefined, undefined, "node",
        ...Array(6).fill(undefined), { allow: [], deny: ["Read(../peer/**)"] }, ...Array(5).fill(undefined), block);
      const launch = String(sendText.mock.calls[0]![1]);
      expect(launch.match(/'--settings'/g)).toHaveLength(1);
      expect(launch).toContain('"deny":["Read(../peer/**)"]');
      expect(launch).toContain(`"autoMode":${JSON.stringify(block)}`);
    });

    it("returns { ok: true } on success", async () => {
      const adapter = new ClaudeResumeAdapter(mockTmux());
      const result = await adapter.resume("r99-demo1-lead", "claude_name", "my-session", "/repo");
      expect(result).toEqual({ ok: true, appliedLaunch: CLAUDE_FLOOR_EFFECT });
    });

    it("returns { ok: false, code: 'resume_failed' } on sendText failure", async () => {
      const sendText = vi.fn(async () => ({ ok: false as const, code: "session_not_found", message: "err" }));
      const adapter = new ClaudeResumeAdapter(mockTmux({ sendText }));
      const result = await adapter.resume("r99-demo1-lead", "claude_name", "my-session", "/repo");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("resume_failed");
    });

    it("resume_type=none -> { ok: false, code: 'no_resume' }", async () => {
      const adapter = new ClaudeResumeAdapter(mockTmux());
      const result = await adapter.resume("r99-demo1-lead", "none", "token", "/repo");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("no_resume");
    });

    it("no token -> { ok: false, code: 'no_resume' }", async () => {
      const adapter = new ClaudeResumeAdapter(mockTmux());
      const result = await adapter.resume("r99-demo1-lead", "claude_name", null, "/repo");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("no_resume");
    });

    it("shell-sensitive token is quoted in command", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const adapter = new ClaudeResumeAdapter(mockTmux({ sendText, sendKeys }));

      await adapter.resume("r99-demo1-lead", "claude_name", "tok; rm -rf /", "/repo");

      expect(sendText.mock.calls[0]![1]).toBe("OPENRIG_RESUME_LAUNCH='tok; rm -rf /' CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 claude --permission-mode acceptEdits --resume 'tok; rm -rf /'");
    });

    it("sendKeys(Enter) fails after sendText -> C-c sent to clear buffer", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn()
        .mockResolvedValueOnce({ ok: false as const, code: "session_not_found", message: "err" }) // Enter fails
        .mockResolvedValueOnce({ ok: true as const }); // C-c succeeds
      const adapter = new ClaudeResumeAdapter(mockTmux({ sendText, sendKeys }));

      const result = await adapter.resume("r99-demo1-lead", "claude_name", "my-session", "/repo");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("resume_failed");
      // C-c cleanup was attempted
      expect(sendKeys).toHaveBeenCalledTimes(2);
      expect(sendKeys.mock.calls[1]![1]).toEqual(["C-c"]);
    });

    it("sendText fails -> NO C-c attempt", async () => {
      const sendText = vi.fn(async () => ({ ok: false as const, code: "session_not_found", message: "err" }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const adapter = new ClaudeResumeAdapter(mockTmux({ sendText, sendKeys }));

      await adapter.resume("r99-demo1-lead", "claude_name", "my-session", "/repo");

      // sendKeys should NOT have been called at all (no Enter, no C-c)
      expect(sendKeys).not.toHaveBeenCalled();
    });

    it("returns retry_fresh when Claude prints no conversation found and drops back to shell", async () => {
      const getPaneCommand = vi.fn(async () => "zsh");
      const capturePaneContent = vi.fn(async () => "No conversation found with session ID: abc123\nuser@example.test %");
      const adapter = new ClaudeResumeAdapter(
        mockTmux({ getPaneCommand, capturePaneContent }),
        { pollMs: 0, maxWaitMs: 0, sleep: async () => {} }
      );

      const result = await adapter.resume("r99-demo1-lead", "claude_name", "missing-session", "/repo");

      expect(result).toEqual({
        ok: false,
        code: "retry_fresh",
        message: "Claude resume failed: no conversation found for the requested session",
      });
    });

    it.each([
      [null, null],
      ["2.1.283", "Restored conversation\n❯\n  ⏵⏵ bypass permissions on (shift+tab to cycle)"],
      ["zsh", "Accessing workspace:\nYes, I trust this folder"],
    ])("preserves inconclusive observations without claiming resume (%s)", async (command, content) => {
      const adapter = new ClaudeResumeAdapter(mockTmux({
        getPaneCommand: async () => command,
        capturePaneContent: async () => content,
      }), { pollMs: 0, maxWaitMs: 0 });
      expect(await adapter.resume("worker", "claude_id", "retained-history", "/repo"))
        .toMatchObject({ ok: false, code: "attention_required", message: expect.stringContaining("launch retained") });
    });

    it.each(["command", "capture"])("preserves the launch when %s observation throws", async failedRead => {
      const adapter = new ClaudeResumeAdapter(mockTmux({
        getPaneCommand: async () => { if (failedRead === "command") throw new Error("observation unavailable"); return "2.1.283"; },
        capturePaneContent: async () => { throw new Error("observation unavailable"); },
      }), { pollMs: 0, maxWaitMs: 0 });
      expect(await adapter.resume("worker", "claude_id", "retained-history", "/repo"))
        .toMatchObject({ ok: false, code: "attention_required", message: expect.stringContaining("observation unavailable") });
    });

    // The older resume path reports a conversation resumed to Claude's login refusal as the managed resume does, under its
    // gate evidence: no pane provably back at an idle shell, and no other conversation's Claude in it. Otherwise the launch is
    // kept with the qualified report. Either way it names the refusal row, never the screen (its refused turn may be startup text).
    describe("a conversation resumed to Claude's login refusal", () => {
      const startedAt = "Sat Jan  1 12:00:00 2000";
      const shell = { pid: 4321, ppid: 1, pgid: 4321, tpgid: 4321, command: "-zsh", executableName: "zsh", startedAt };
      const claudeRunning = (token: string) => [{ ...shell, tpgid: 4400 },
        { pid: 4400, ppid: 4321, pgid: 4400, tpgid: 4400, command: `claude --permission-mode acceptEdits --resume ${token} --name worker`, executableName: "claude", startedAt }];
      const screen = fs.readFileSync(new URL("./fixtures/claude-login-resume-2.1.330.txt", import.meta.url), "utf8");
      const signIn = "The resumed Claude conversation's latest reply is Claude's login refusal (\"Not logged in · Please run /login\"). "
        + "If this seat isn't signed in, open its terminal and run /login there. The conversation was kept, and nothing was typed into it.";
      const qualified = "Claude resume could not be verified; launch retained: Claude is running but cannot continue until the user logs in.";
      it.each([
        ["this launch's own Claude holds the pane", "claude", screen, async () => claudeRunning("retained-history"), signIn],
        ["the process table can't be read, so nothing rules it out", "claude", screen, async () => { throw new Error("ps unavailable"); }, signIn],
        ["the pane is provably back at an idle shell under the refusal Claude left", "zsh", `${screen}\nuser@host:~/project$ `, async () => [shell], qualified],
        ["another conversation's Claude holds the pane", "claude", screen, async () => claudeRunning("some-other-conversation"), qualified],
      ])("keeps the launch and reports the refusal row when %s", async (_case, command, content, listProcesses, message) => {
        const adapter = new ClaudeResumeAdapter(mockTmux({ getPaneCommand: async () => command, capturePaneContent: async () => content,
          getPanePid: async () => 4321 }), { pollMs: 0, maxWaitMs: 0, listProcesses });
        const result = await adapter.resume("worker", "claude_id", "retained-history", "/repo");
        expect(result).toEqual({ ok: false, code: "attention_required", message, evidence: "  ⎿  Not logged in · Please run /login" });
        expect(JSON.stringify(result)).not.toContain("hello");
      });
    });

    it.each([
      ["No conversation found", "retry_fresh"],
      ["How would you like to resume?\n❯ Resume from summary\n  Resume full session as-is", "attention_required"],
    ])("retains the final observation's distinction: %s", async (content, code) => {
      const capturePaneContent = vi.fn().mockResolvedValueOnce("").mockResolvedValue(content);
      const adapter = new ClaudeResumeAdapter(mockTmux({
        getPaneCommand: async () => "2.1.283", capturePaneContent,
      }), { pollMs: 0, maxWaitMs: 0 });
      expect(await adapter.resume("worker", "claude_id", "retained-history", "/repo"))
        .toMatchObject({ ok: false, code });
    });

    it("retains positive returned-to-shell refusal", async () => {
      // Positive: the pane's own shell owns the foreground, alone in its group, in both samples.
      const adapter = new ClaudeResumeAdapter(mockTmux({
        getPaneCommand: async () => "zsh", capturePaneContent: async () => "$ ", getPanePid: async () => 4321,
      }), { pollMs: 0, maxWaitMs: 0, listProcesses: async () => [
        { pid: 4321, ppid: 1, pgid: 4321, tpgid: 4321, command: "-zsh", executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000" },
      ] });
      expect(await adapter.resume("worker", "claude_id", "retained-history", "/repo"))
        .toMatchObject({ ok: false, code: "retry_fresh" });
    });

    // A new pane's shell still running its startup files is the same idle shell in both samples; it hasn't read the
    // launch, whose staged script (it removes itself first) is still there. Reported on 0.7.18 as "pane returned to shell"
    // with the original conversation running a moment later.
    it.each([
      ["hasn't read the staged launch yet: the launch is kept", true, "attention_required"],
      ["read the staged launch and is back at its prompt: the return stands", false, "retry_fresh"],
    ] as const)("a pane whose shell %s", async (_label, unread, code) => {
      const tmux = mockTmux({ getPaneCommand: async () => "zsh", capturePaneContent: async () => "$ ", getPanePid: async () => 4321 });
      tmux.sendShellCommand = vi.fn(async () => ({ ok: true as const }));
      tmux.stagedLaunchUnread = vi.fn(() => unread);
      const adapter = new ClaudeResumeAdapter(tmux, { pollMs: 0, maxWaitMs: 0,
        seatLaunchEnvironment: { command: async (_session: string, command: string) => command } as never,
        listProcesses: async () => [
          { pid: 4321, ppid: 1, pgid: 4321, tpgid: 4321, command: "-zsh", executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000" },
        ] });
      const result = await adapter.resume("worker", "claude_id", "retained-history", "/repo");
      expect(result, JSON.stringify(result)).toMatchObject({ ok: false, code });
      expect(tmux.sendShellCommand).toHaveBeenCalled();
      expect(tmux.stagedLaunchUnread).toHaveBeenCalledWith("worker");
      if (unread) expect((result as { message: string }).message).toContain("hasn't read the launch yet");
    });

    // An earlier launch's "No conversation found" can still be on screen in a reused pane. While the staged launch is
    // unread Claude hasn't run, so that text can't be this launch's: the stored conversation isn't abandoned for it.
    // Once the shell reads the launch, only a report below its typed line (naming the staged script) is this launch's.
    it.each([
      ["hasn't read the staged launch yet: an earlier launch's report keeps the launch", true, "attention_required"],
      ["read the staged launch: a report below its typed line is this launch's", false, "retry_fresh"],
    ] as const)("a pane already showing \"No conversation found\" whose shell %s", async (_label, unread, code) => {
      const tmux = mockTmux({ getPaneCommand: async () => "zsh", getPanePid: async () => 4321,
        capturePaneContent: async () => `No conversation found with session ID: old\n$ ${unread ? "" : `${typedLaunch}\nNo conversation found with session ID: retained-history\n$ `}` });
      tmux.sendShellCommand = vi.fn(async () => ({ ok: true as const }));
      tmux.stagedLaunchUnread = vi.fn(() => unread);
      tmux.stagedLaunchTypedLine = vi.fn(() => typedLaunch);
      const adapter = new ClaudeResumeAdapter(tmux, { pollMs: 0, maxWaitMs: 0,
        seatLaunchEnvironment: { command: async (_session: string, command: string) => command } as never });
      const result = await adapter.resume("worker", "claude_id", "retained-history", "/repo");
      expect(result, JSON.stringify(result)).toMatchObject({ ok: false, code });
      if (unread) expect((result as { message: string }).message).toContain("may be from an earlier launch (the pane's shell hasn't read this launch yet)");
    });

    // #3843 r2: the report is placed by this launch's own typed line, not by how many reports are on screen.
    describe("an earlier launch's \"No conversation found\" is told apart by the launch's typed line", () => {
      // `frames(n)` is the nth capture; the shell has read the launch from capture `readAt` on.
      const staged = (frames: (n: number) => string, opts: { readAt?: number; command?: string } = {}) => {
        let read = 0;
        let unread = (opts.readAt ?? 0) > 0;
        const tmux = mockTmux({ getPaneCommand: async () => opts.command ?? "zsh", capturePaneContent: async () => {
          const n = read++;
          unread = n < (opts.readAt ?? 0);
          return frames(n);
        } });
        tmux.sendShellCommand = vi.fn(async () => ({ ok: true as const }));
        tmux.stagedLaunchUnread = vi.fn(() => unread);
        tmux.stagedLaunchTypedLine = vi.fn(() => typedLaunch);
        const adapter = new ClaudeResumeAdapter(tmux, { pollMs: 1, maxWaitMs: 3, sleep: async () => {},
          seatLaunchEnvironment: { command: async (_session: string, command: string) => command } as never });
        return { adapter, reads: () => read };
      };
      const old = "No conversation found with session ID: old\n$ ";

      // The reviewer's cells (review50-r2, reviewer-count-edges.patch), with the typed line the pane shows once the shell
      // has read the launch.
      it("an old report that scrolled out (or was replaced), then this launch's own report below its typed line: retried fresh", async () => {
        const { adapter, reads } = staged(n => n === 0 ? old : n === 1 ? "starting..." : `$ ${typedLaunch}\nNo conversation found with session ID: retained-history`, { readAt: 1 });
        const result = await adapter.resume("worker", "claude_id", "retained-history", "/repo");
        expect(result, JSON.stringify({ result, read: reads() })).toMatchObject({ ok: false, code: "retry_fresh" });
      });

      it("two launches in one pane: each is judged by its own typed line", async () => {
        let launch = 0;
        const lines = ["aaaaaaaa", "bbbbbbbb"].map(id => `( . '/tmp/openrig-tmux-send-4242-${id}-1111-4222-8333-444455556666.txt' )`);
        const tmux = mockTmux({ getPaneCommand: async () => "zsh", capturePaneContent: async () => launch === 1
          ? "No conversation found with session ID: old\nNo conversation found with session ID: older\n$ "
          : `No conversation found with session ID: old\nNo conversation found with session ID: older\n$ ${lines[1]}\nNo conversation found with session ID: second\n$ ` });
        tmux.sendShellCommand = vi.fn(async () => { launch++; return { ok: true as const }; });
        tmux.stagedLaunchUnread = vi.fn(() => launch === 1);
        tmux.stagedLaunchTypedLine = vi.fn(() => lines[launch - 1]);
        const adapter = new ClaudeResumeAdapter(tmux, { pollMs: 1, maxWaitMs: 3, sleep: async () => {},
          seatLaunchEnvironment: { command: async (_session: string, command: string) => command } as never });
        expect(await adapter.resume("worker", "claude_id", "first", "/repo")).toMatchObject({ code: "attention_required" });
        expect(await adapter.resume("worker", "claude_id", "second", "/repo")).toMatchObject({ code: "retry_fresh" });
        expect(launch).toBe(2);
      });

      it.each([
        ["twice", `${old}${old}`],
        ["once", old],
      ])("a redraw that reprints the old report %s above the typed line doesn't hide the resumed screen below it", async (_label, reprint) => {
        const { adapter } = staged(n => n === 0 ? old : `${reprint}${typedLaunch}\n${DRAWN_CLAUDE}`, { readAt: 1, command: "claude" });
        expect(await adapter.resume("worker", "claude_id", "retained-history", "/repo")).toMatchObject({ ok: true });
      });

      // A shell already at its prompt reads the launch before the first poll, so it's never seen unread.
      it("a shell that read the launch before the first poll: an earlier report above its typed line isn't this launch's", async () => {
        const { adapter } = staged(() => `${old}${typedLaunch}\n${DRAWN_CLAUDE}`, { command: "claude" });
        expect(await adapter.resume("worker", "claude_id", "retained-history", "/repo")).toMatchObject({ ok: true });
      });

      it("a shell that read the launch before the first poll: a report below its typed line is this launch's", async () => {
        const { adapter } = staged(() => `${old}${typedLaunch}\nNo conversation found with session ID: retained-history\n$ `);
        expect(await adapter.resume("worker", "claude_id", "retained-history", "/repo")).toMatchObject({ ok: false, code: "retry_fresh" });
      });

      // review50-r2 (reviewer-tests.patch): the script's name in output isn't the typed line, so it moves nothing.
      it("reviewer anchor: a later message naming the script doesn't hide this launch's missing report", async () => {
        const { adapter, reads } = staged(() => `${typedLaunch}\nNo conversation found with session ID: retained-history\ndiagnostic: ${launchName} finished\n$ `, { command: "claude" });
        const result = await adapter.resume("worker", "claude_id", "retained-history", "/repo");
        expect(result, JSON.stringify({ result, read: reads() })).toMatchObject({ ok: false, code: "retry_fresh" });
      });

      it("reviewer anchor: the script's name in output alone leaves whose report it is unknown", async () => {
        const { adapter, reads } = staged(() => `diagnostic: ${launchName}\nNo conversation found with session ID: old`, { command: "claude" });
        const result = await adapter.resume("worker", "claude_id", "retained-history", "/repo");
        expect(result, JSON.stringify({ result, read: reads() })).toMatchObject({ ok: false, code: "attention_required" });
      });

      it("reviewer anchor: a typed line split inside the script's name still places this launch's report", async () => {
        const wrap = typedLaunch.replace(launchName, launchName.slice(0, 23) + "\n" + launchName.slice(23));
        const { adapter } = staged(() => `${wrap}\nNo conversation found with session ID: retained-history`, { command: "claude" });
        expect(await adapter.resume("worker", "claude_id", "retained-history", "/repo")).toMatchObject({ ok: false, code: "retry_fresh" });
      });

      it("a report with the typed line out of view keeps polling, and ends saying whose it is can't be told", async () => {
        const { adapter, reads } = staged(() => "No conversation found with session ID: retained-history\n$ ");
        const result = await adapter.resume("worker", "claude_id", "retained-history", "/repo");
        expect(result).toMatchObject({ ok: false, code: "attention_required",
          message: "Claude resume could not be verified; launch retained: the \"No conversation found\" on screen may be from an earlier launch (this launch's typed line, which would tell, isn't in view), so Claude may still be starting." });
        // The four polls the bound gives, then the final read: no budget past it.
        expect(reads()).toBe(5);
      });

      it("an earlier report above the typed line, with nothing below yet, ends as the shell check says, not as a missing conversation", async () => {
        const tmux = mockTmux({ getPaneCommand: async () => "zsh", capturePaneContent: async () => `${old}${typedLaunch}\n`, getPanePid: async () => 4321 });
        tmux.sendShellCommand = vi.fn(async () => ({ ok: true as const }));
        tmux.stagedLaunchUnread = vi.fn(() => false);
        tmux.stagedLaunchTypedLine = vi.fn(() => typedLaunch);
        const adapter = new ClaudeResumeAdapter(tmux, { pollMs: 0, maxWaitMs: 0,
          seatLaunchEnvironment: { command: async (_session: string, command: string) => command } as never,
          listProcesses: async () => [
            { pid: 4321, ppid: 1, pgid: 4321, tpgid: 4321, command: "-zsh", executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000" },
          ] });
        expect(await adapter.resume("worker", "claude_id", "retained-history", "/repo"))
          .toEqual({ ok: false, code: "retry_fresh", message: "Claude resume failed: pane returned to shell instead of entering Claude" });
      });
    });

    it("waits for Claude to become the foreground command, and accepts a foreground Claude with nothing drawn only at its final read", async () => {
      const getPaneCommand = vi
        .fn<(_: string) => Promise<string | null>>()
        .mockResolvedValueOnce("zsh")
        .mockResolvedValue("claude");
      const capturePaneContent = vi.fn(async () => "");
      const adapter = new ClaudeResumeAdapter(
        mockTmux({ getPaneCommand, capturePaneContent }),
        { pollMs: 0, maxWaitMs: 1, sleep: async () => {} }
      );

      const result = await adapter.resume("r99-demo1-lead", "claude_name", "my-session", "/repo");

      // Nothing drawn: the process alone stands once the wait (two polls and the final read) runs out, and says so.
      expect(result).toEqual({ ok: true, appliedLaunch: CLAUDE_FLOOR_EFFECT, warnings: [expect.stringContaining("rests on the process alone")] });
      // Two polls in the window, then the final read.
      expect(getPaneCommand).toHaveBeenCalledTimes(3);
    });

    it("keeps polling past a foreground Claude, so the missing conversation it then reports is retry_fresh, not success", async () => {
      // A resume of a conversation that doesn't exist: Claude is the foreground process with nothing drawn, then
      // prints "No conversation found" and the pane is back at its shell.
      const getPaneCommand = vi
        .fn<(_: string) => Promise<string | null>>()
        .mockResolvedValueOnce("claude")
        .mockResolvedValueOnce("claude")
        .mockResolvedValue("zsh");
      const capturePaneContent = vi
        .fn<(_: string, __?: number) => Promise<string | null>>()
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("")
        .mockResolvedValue("No conversation found with session ID: missing-session\nuser@example.test %");
      const adapter = new ClaudeResumeAdapter(
        mockTmux({ getPaneCommand, capturePaneContent }),
        { pollMs: 0, maxWaitMs: 3, sleep: async () => {} }
      );

      const result = await adapter.resume("r99-demo1-lead", "claude_name", "missing-session", "/repo");

      expect(result).toEqual({
        ok: false,
        code: "retry_fresh",
        message: "Claude resume failed: no conversation found for the requested session",
      });
      expect(getPaneCommand).toHaveBeenCalledTimes(3);
    });

    it("doesn't end the wait on Claude's process alone, and meets the trust dialog Claude draws next", async () => {
      const dialog = readFileSync(new URL("./fixtures/claude-trust-2.1.310.txt", import.meta.url), "utf8");
      const capturePaneContent = vi.fn<(_: string, __?: number) => Promise<string | null>>(async () => dialog)
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce(dialog.split("\n")[0]!);
      const adapter = new ClaudeResumeAdapter(mockTmux({ getPaneCommand: vi.fn(async () => "claude"), capturePaneContent }),
        { pollMs: 0, maxWaitMs: 3, sleep: async () => {} });

      const result = await adapter.resume("r99-demo1-lead", "claude_name", "my-session", "/repo");

      expect(result).toMatchObject({ ok: false, code: "attention_required" });
      expect((result as { message: string }).message).toContain("workspace trust");
    });

    it("accepts Claude's process alone only when the wait runs out, and says the resume rests on it", async () => {
      const capturePaneContent = vi.fn(async () => "");
      const adapter = new ClaudeResumeAdapter(mockTmux({ getPaneCommand: vi.fn(async () => "claude"), capturePaneContent }),
        { pollMs: 0, maxWaitMs: 2, sleep: async () => {} });

      const result = await adapter.resume("r99-demo1-lead", "claude_name", "my-session", "/repo");

      expect(result).toMatchObject({ ok: true, warnings: [expect.stringContaining("rests on the process alone")] });
      expect(capturePaneContent).toHaveBeenCalledTimes(4);
    });

    it("treats a live Claude TUI as success even when tmux reports a version-string foreground command", async () => {
      const getPaneCommand = vi
        .fn<(_: string) => Promise<string | null>>()
        .mockResolvedValueOnce("zsh")
        .mockResolvedValueOnce("2.1.89");
      const capturePaneContent = vi
        .fn<(_: string, __?: number) => Promise<string | null>>()
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce(
          [
            "Claude Code v2.1.89",
            "❯ Baseline warmup 4/6 for dev.impl.",
            "────────────────────────────────────────────────────────────────────────────────",
            "  ? for shortcuts                                             ● high · /effort",
          ].join("\n")
        );
      const adapter = new ClaudeResumeAdapter(
        mockTmux({ getPaneCommand, capturePaneContent }),
        { pollMs: 0, maxWaitMs: 1, sleep: async () => {} }
      );

      const result = await adapter.resume("r99-demo1-lead", "claude_name", "my-session", "/repo");

      expect(result).toEqual({ ok: true, appliedLaunch: CLAUDE_FLOOR_EFFECT });
    });

    // OPR.0.3.4.5 — regression guard behavior 05: CONSUMER human gate.
    // On a Claude resume-selection menu, the REAL consumer sends ZERO
    // selection keystrokes and returns attention_required. This is
    // safety-critical: auto-keying the menu is governance BLOCKING.
    it("OPR.0.3.4.5 guard (05): resume-selection menu -> attention_required, ZERO selection keystrokes sent", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const getPaneCommand = vi.fn(async () => "claude");
      const capturePaneContent = vi.fn(async () => [
        "Choose a conversation to resume:",
        "",
        "  1. project-foo",
        "  2. project-bar",
        "  3. project-baz",
        "",
        "Enter your choice (1-3):",
      ].join("\n"));
      const adapter = new ClaudeResumeAdapter(
        mockTmux({ sendText, sendKeys, getPaneCommand, capturePaneContent }),
        { pollMs: 0, maxWaitMs: 0, sleep: async () => {} },
      );

      const result = await adapter.resume("r99-worker", "claude_name", "my-session", "/repo");

      // attention_required, not failed
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("attention_required");
        expect(result.message).toBeTruthy();
      }
      // THE GUARD: no numeric selection keystroke was sent.
      // sendText has only the initial `claude --resume ...` command.
      // sendKeys has only the initial Enter. Nothing else — no "1", no "2".
      const allSendTextArgs = sendText.mock.calls.map((c) => String(c[1] ?? ""));
      const allSendKeysArgs = sendKeys.mock.calls.flatMap((c) => {
        const arg = c[1];
        return Array.isArray(arg) ? arg : [String(arg ?? "")];
      });
      for (const s of [...allSendTextArgs, ...allSendKeysArgs]) {
        expect(s).not.toMatch(/^[0-9]+$/);
      }
      // Explicitly: only the launch command + Enter were sent.
      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText.mock.calls[0]![1]).toContain("claude --permission-mode acceptEdits --resume");
      expect(sendKeys).toHaveBeenCalledTimes(1);
      expect(sendKeys.mock.calls[0]![1]).toEqual(["Enter"]);
    });

    it("current resume-mode chooser returns attention immediately with no selection input", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const sleep = vi.fn(async () => {});
      const adapter = new ClaudeResumeAdapter(
        mockTmux({
          sendText,
          sendKeys,
          getPaneCommand: vi.fn(async () => "claude"),
          capturePaneContent: vi.fn(async () => [
            "How would you like to resume?",
            "❯ Resume from summary",
            "  Resume full session as-is",
          ].join("\n")),
        }),
        { pollMs: 200, maxWaitMs: 5_000, sleep },
      );

      const result = await adapter.resume("r99-worker", "claude_name", "my-session", "/repo");

      expect(result).toMatchObject({ ok: false, code: "attention_required" });
      expect(sleep).not.toHaveBeenCalled();
      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendKeys).toHaveBeenCalledTimes(1);
      expect(sendKeys).toHaveBeenCalledWith("r99-worker", ["Enter"]);
    });

    it("treats both chooser labels in ordinary active-TUI prose as resumed", async () => {
      const adapter = new ClaudeResumeAdapter(
        mockTmux({
          getPaneCommand: vi.fn(async () => "2.1.89"),
          capturePaneContent: vi.fn(async () => [
            "Claude Code v2.1.89",
            "❯ Compare Resume from summary with Resume full session as-is in the recovery notes.",
            "────────────────────────────────────────────────────────────────────────────────",
            "  ⏵⏵ accept edits on (shift+tab to cycle)                     ● high · /effort",
          ].join("\n")),
        }),
        { pollMs: 0, maxWaitMs: 0, sleep: async () => {} },
      );

      const result = await adapter.resume("r99-worker", "claude_name", "my-session", "/repo");

      expect(result).toEqual({ ok: true, appliedLaunch: CLAUDE_FLOOR_EFFECT });
    });

    it("treats the edit-approval footer as a live Claude TUI during resume verification", async () => {
      const getPaneCommand = vi
        .fn<(_: string) => Promise<string | null>>()
        .mockResolvedValueOnce("2.1.89");
      const capturePaneContent = vi
        .fn<(_: string, __?: number) => Promise<string | null>>()
        .mockResolvedValueOnce(
          [
            "Loading startup skills and recovering identity.",
            "",
            "────────────────────────────────────────────────────────────────────────────────",
            "❯ ",
            "────────────────────────────────────────────────────────────────────────────────",
            "  ⏵⏵ accept edits on (shift+tab to cycle)                     ● high · /effort",
          ].join("\n")
        );
      const adapter = new ClaudeResumeAdapter(
        mockTmux({ getPaneCommand, capturePaneContent }),
        { pollMs: 0, maxWaitMs: 1, sleep: async () => {} }
      );

      const result = await adapter.resume("r99-demo1-lead", "claude_name", "my-session", "/repo");

      expect(result).toEqual({ ok: true, appliedLaunch: CLAUDE_FLOOR_EFFECT });
    });

    it.each(["2.1.283", "sh"])("accepts a headerless bypass-mode prompt with exact resume lineage behind %s", async (paneCommand) => {
      const tmux = mockTmux({
        getPanePid: vi.fn(async () => 1234),
        getPaneCommand: vi.fn(async () => paneCommand),
        capturePaneContent: vi.fn(async () => [
          "Restored conversation",
          "❯",
          "⏵⏵ bypass permissions on (shift+tab to cycle)",
        ].join("\n")),
      });
      const adapter = new ClaudeResumeAdapter(tmux, {
        pollMs: 0,
        maxWaitMs: 0,
        sleep: async () => {},
        listProcesses: async () => [
          { pid: 1234, ppid: 1, pgid: 1234, tpgid: 1235, command: "bash", executableName: "bash", startedAt: "Sat Jan  1 12:00:00 2000" },
          { pid: 1235, ppid: 1234, pgid: 1235, tpgid: 1235, command: "claude --permission-mode acceptEdits --resume resume-id", executableName: "claude", startedAt: "Sat Jan  1 12:00:00 2000" },
        ],
      });

      const result = await adapter.resume("r99-demo1-lead", "claude_id", "resume-id", "/repo");

      // The process the identity check proved is the launch's record of what it started (#1077).
      expect(result).toEqual({ ok: true, appliedLaunch: CLAUDE_FLOOR_EFFECT, launchedProcess: { pid: 1235, startedAt: "Sat Jan  1 12:00:00 2000" } });
    });

    // #2508: a classic resume whose launch subshell didn't exec Claude (an rc alias or function, or a launch whose
    // environment correction fell back) leaves the shell as the pane's label. Before Claude's prompt shows, a proven
    // Claude naming this resume beneath that subshell is the foreground runtime, as a `claude` label is.
    it("accepts a proven Claude beneath the launch subshell before its prompt shows", async () => {
      const tmux = mockTmux({
        getPanePid: vi.fn(async () => 1234),
        getPaneCommand: vi.fn(async () => "zsh"),
        capturePaneContent: vi.fn(async () => ""),
      });
      const adapter = new ClaudeResumeAdapter(tmux, {
        pollMs: 0,
        maxWaitMs: 0,
        sleep: async () => {},
        listProcesses: async () => [
          { pid: 1234, ppid: 1, pgid: 1234, tpgid: 1235, command: "-zsh", executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000" },
          { pid: 1235, ppid: 1234, pgid: 1235, tpgid: 1235, command: "-zsh", executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000" },
          { pid: 1236, ppid: 1235, pgid: 1235, tpgid: 1235, command: "claude --permission-mode acceptEdits --resume resume-id", executableName: "claude", startedAt: "Sat Jan  1 12:00:00 2000" },
        ],
      });

      const result = await adapter.resume("r99-demo1-lead", "claude_id", "resume-id", "/repo");

      expect(result).toEqual({ ok: true, appliedLaunch: CLAUDE_FLOOR_EFFECT, launchedProcess: { pid: 1236, startedAt: "Sat Jan  1 12:00:00 2000" } });
    });

    it.each([
      ["2.1.283", "attention_required"],
      // The shell label isn't a proven idle shell: another Claude holds the foreground, so the launch is kept.
      ["sh", "attention_required"],
    ] as const)("does not accept the prompt behind %s when the native process carries another resume token", async (paneCommand, expectedCode) => {
      const tmux = mockTmux({
        getPanePid: vi.fn(async () => 1234),
        getPaneCommand: vi.fn(async () => paneCommand),
        capturePaneContent: vi.fn(async () => "Restored conversation\n❯\n⏵⏵ bypass permissions on"),
      });
      const adapter = new ClaudeResumeAdapter(tmux, {
        pollMs: 0,
        maxWaitMs: 0,
        sleep: async () => {},
        listProcesses: async () => [
          { pid: 1234, ppid: 1, pgid: 1234, tpgid: 1235, command: "bash", executableName: "bash", startedAt: "Sat Jan  1 12:00:00 2000" },
          { pid: 1235, ppid: 1234, pgid: 1235, tpgid: 1235, command: "claude --permission-mode acceptEdits --resume another-session", executableName: "claude", startedAt: "Sat Jan  1 12:00:00 2000" },
        ],
      });

      const result = await adapter.resume("r99-demo1-lead", "claude_id", "resume-id", "/repo");

      expect(result).toMatchObject({ ok: false, code: expectedCode });
    });
  });
});
