import { describe, expect, it, vi } from "vitest";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";

function terminal() {
  return { sendShellCommand: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })), sendKeys: vi.fn(async () => ({ ok: true as const })) };
}

describe("selected native dispatch guard", () => {
  it("rechecks Codex after awaited managed configuration before any native input", async () => {
    const tmux = terminal(); let current = true;
    const adapter = new CodexResumeAdapter(tmux as unknown as TmuxAdapter, {
      ensureManagedConfig: async () => { current = false; },
    });
    const result = await adapter.resume("seat@rig", "codex_id", "older-id", "/repo",
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      () => current);
    expect(result).toMatchObject({ ok: false, code: "attention_required" });
    expect(tmux.sendShellCommand).not.toHaveBeenCalled();
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it("supplies Codex's last input guard after preparation", async () => {
    const tmux = terminal(); let current = true; let guarded = false;
    tmux.sendShellCommand = vi.fn(async (_target: string, _command: string, beforeInput?: () => void) => {
      current = false;
      expect(() => beforeInput?.()).toThrow("Selected history changed");
      guarded = true;
      return { ok: false as const, message: "guarded" };
    });
    const adapter = new CodexResumeAdapter(tmux as unknown as TmuxAdapter);
    await adapter.resume("seat@rig", "codex_id", "older-id", "/repo",
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      () => current);
    expect(guarded).toBe(true);
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it("rechecks Claude after awaited shell preparation and at the input callback", async () => {
    const tmux = terminal(); let current = true;
    const staged = { command: vi.fn(async () => { current = false; return "staged-command"; }) };
    const adapter = new ClaudeResumeAdapter(tmux as unknown as TmuxAdapter, { seatLaunchEnvironment: staged as never });
    const denied = await adapter.resume("seat@rig", "claude_name", "older-name", "/repo",
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, () => current);
    expect(denied.ok).toBe(false);
    expect(tmux.sendShellCommand).not.toHaveBeenCalled();
    expect(tmux.sendText).not.toHaveBeenCalled();

    current = true;
    staged.command.mockImplementation(async () => "staged-command");
    let guarded = false;
    tmux.sendShellCommand = vi.fn(async (_target: string, _command: string, beforeInput?: () => void) => {
      current = false;
      expect(() => beforeInput?.()).toThrow("Selected history changed");
      guarded = true;
      return { ok: false as const, message: "guarded" };
    });
    await adapter.resume("seat@rig", "claude_name", "older-name", "/repo",
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, () => current);
    expect(guarded).toBe(true);
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it.each(["codex", "claude-code"] as const)("rechecks %s pod launch after staging and at tmux input", async runtime => {
    const tmux = terminal(); let current = true;
    const staged = { command: vi.fn(async () => { current = false; return "staged-command"; }) };
    const fsOps = { exists: () => false, readFile: () => "", writeFile: () => {}, mkdirp: () => {},
      listFiles: () => [], copyFile: () => {}, readdir: () => [] };
    const adapter = runtime === "codex"
      ? new CodexRuntimeAdapter({ tmux: tmux as unknown as TmuxAdapter, fsOps, seatLaunchEnvironment: staged as never,
        sleep: async () => {} })
      : new ClaudeCodeAdapter({ tmux: tmux as unknown as TmuxAdapter, fsOps, seatLaunchEnvironment: staged as never,
        sleep: async () => {} });
    const binding = { id: "binding", nodeId: "node", cwd: "/repo", tmuxSession: "seat@rig", tmuxPane: "%1",
      tmuxWindow: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "" };
    const options = { name: "seat@rig", resumeToken: "older-conversation", beforeNativeDispatch: () => current };
    const denied = await adapter.launchHarness(binding, options);
    expect(denied).toMatchObject(runtime === "codex"
      ? { ok: false, recovery: "attention_required" }
      : { ok: false, error: expect.stringContaining("Selected history changed") });
    expect(tmux.sendShellCommand).not.toHaveBeenCalled();
    expect(tmux.sendText).not.toHaveBeenCalled();

    current = true;
    staged.command.mockImplementation(async () => "staged-command");
    let guarded = false;
    tmux.sendShellCommand = vi.fn(async (_target: string, _command: string, beforeInput?: () => void) => {
      current = false;
      expect(() => beforeInput?.()).toThrow("Selected history changed");
      guarded = true;
      return { ok: false as const, message: "guarded" };
    });
    const blockedAtInput = await adapter.launchHarness(binding, options);
    expect(blockedAtInput.ok).toBe(false);
    expect(guarded).toBe(true);
    expect(tmux.sendText).not.toHaveBeenCalled();
  });
});
