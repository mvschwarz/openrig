import { describe, it, expect, vi } from "vitest";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";

function mockTmux(overrides?: {
  sendText?: (target: string, text: string) => Promise<TmuxResult>;
  sendKeys?: (target: string, keys: string[]) => Promise<TmuxResult>;
  getPaneCommand?: (target: string) => Promise<string | null>;
  capturePaneContent?: (target: string, lines?: number) => Promise<string | null>;
}) {
  return {
    sendText: overrides?.sendText ?? vi.fn(async () => ({ ok: true as const })),
    sendKeys: overrides?.sendKeys ?? vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: overrides?.getPaneCommand ?? vi.fn(async () => "claude"),
    capturePaneContent: overrides?.capturePaneContent ?? vi.fn(async () => ""),
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    hasSession: async () => false,
  } as unknown as TmuxAdapter;
}

describe("ClaudeResumeAdapter", () => {
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
      expect(sendText.mock.calls[0]![1]).toBe("claude --resume 'my-session'");
      expect(sendKeys).toHaveBeenCalledOnce();
      expect(sendKeys.mock.calls[0]![0]).toBe("r99-demo1-lead");
      expect(sendKeys.mock.calls[0]![1]).toEqual(["Enter"]);
      // sendText called before sendKeys
      expect(sendText.mock.invocationCallOrder[0]).toBeLessThan(sendKeys.mock.invocationCallOrder[0]!);
    });

    it("returns { ok: true } on success", async () => {
      const adapter = new ClaudeResumeAdapter(mockTmux());
      const result = await adapter.resume("r99-demo1-lead", "claude_name", "my-session", "/repo");
      expect(result).toEqual({ ok: true });
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

      expect(sendText.mock.calls[0]![1]).toBe("claude --resume 'tok; rm -rf /'");
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
      const capturePaneContent = vi.fn(async () => "No conversation found with session ID: abc123\nmschwarz@host %");
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

    it("waits for Claude to become the foreground command before succeeding", async () => {
      const getPaneCommand = vi
        .fn<(_: string) => Promise<string | null>>()
        .mockResolvedValueOnce("zsh")
        .mockResolvedValueOnce("claude");
      const capturePaneContent = vi.fn(async () => "");
      const adapter = new ClaudeResumeAdapter(
        mockTmux({ getPaneCommand, capturePaneContent }),
        { pollMs: 0, maxWaitMs: 1, sleep: async () => {} }
      );

      const result = await adapter.resume("r99-demo1-lead", "claude_name", "my-session", "/repo");

      expect(result).toEqual({ ok: true });
      expect(getPaneCommand).toHaveBeenCalledTimes(2);
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

      expect(result).toEqual({ ok: true });
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
      expect(sendText.mock.calls[0]![1]).toContain("claude --resume");
      expect(sendKeys).toHaveBeenCalledTimes(1);
      expect(sendKeys.mock.calls[0]![1]).toEqual(["Enter"]);
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

      expect(result).toEqual({ ok: true });
    });
  });
});
