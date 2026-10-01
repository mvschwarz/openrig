import { mockShellCommand } from "./helpers/shell-command-mock.js";
import { describe, it, expect, vi } from "vitest";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";

const CODEX_FLOOR_EFFECT = {
  runtime: "codex",
  axis: "sandbox",
  state: "observed",
  value: "workspace-write",
  reason: "emitted_launch_arguments",
} as const;

function mockTmux(overrides?: {
  sendText?: (target: string, text: string) => Promise<TmuxResult>;
  sendKeys?: (target: string, keys: string[]) => Promise<TmuxResult>;
  getPaneCommand?: (target: string) => Promise<string | null>;
  capturePaneContent?: (target: string, lines?: number) => Promise<string | null>;
}) {
  const tmux = {
    sendText: overrides?.sendText ?? vi.fn(async () => ({ ok: true as const })),
    sendKeys: overrides?.sendKeys ?? vi.fn(async () => ({ ok: true as const })),
    // A ready prompt corroborates the foreground process; process name alone is insufficient.
    getPaneCommand: overrides?.getPaneCommand ?? vi.fn(async () => "codex"),
    capturePaneContent: overrides?.capturePaneContent ?? vi.fn(async () => "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything"),
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    hasSession: async () => false,
  } as unknown as TmuxAdapter;
  return mockShellCommand(tmux);
}

describe("CodexResumeAdapter", () => {
  describe("canResume", () => {
    it("codex_id + token -> true", () => {
      const adapter = new CodexResumeAdapter(mockTmux());
      expect(adapter.canResume("codex_id", "uuid-123")).toBe(true);
    });

    it("codex_last WITHOUT token -> true", () => {
      const adapter = new CodexResumeAdapter(mockTmux());
      expect(adapter.canResume("codex_last", null)).toBe(true);
    });

    it("no token + not codex_last -> false", () => {
      const adapter = new CodexResumeAdapter(mockTmux());
      expect(adapter.canResume("codex_id", null)).toBe(false);
    });

    it("claude_name -> false (cross-harness)", () => {
      const adapter = new CodexResumeAdapter(mockTmux());
      expect(adapter.canResume("claude_name", "token")).toBe(false);
    });
  });

  describe("resume", () => {
    it("codex_id: sendText then sendKeys Enter", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({ sendText, sendKeys });
      const adapter = new CodexResumeAdapter(tmux);

      await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");

      expect(sendText).toHaveBeenCalledOnce();
      expect(sendText.mock.calls[0]![0]).toBe("r99-demo1-impl");
      expect(sendText.mock.calls[0]![1]).toBe("codex -s workspace-write resume 'uuid-123'");
      expect(sendKeys).toHaveBeenCalledOnce();
      expect(sendKeys.mock.calls[0]![1]).toEqual(["Enter"]);
      expect(sendText.mock.invocationCallOrder[0]).toBeLessThan(sendKeys.mock.invocationCallOrder[0]!);
    });

    it("0.5.2-07: a SPEC-pinned model threads -m onto the legacy codex resume command", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({ sendText, sendKeys });
      const adapter = new CodexResumeAdapter(tmux);

      await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo", null, undefined, "gpt-5.4-cheap");

      expect(sendText.mock.calls[0]![1]).toBe("codex -s workspace-write -m 'gpt-5.4-cheap' resume 'uuid-123'");
    });

    it("#75: reasoning effort threads -c model_reasoning_effort onto the legacy codex resume command", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({ sendText, sendKeys });
      const adapter = new CodexResumeAdapter(tmux);

      await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo", null, undefined, "gpt-5.4-cheap", "high");

      expect(sendText.mock.calls[0]![1]).toBe("codex -s workspace-write -m 'gpt-5.4-cheap' -c 'model_reasoning_effort=\"high\"' resume 'uuid-123'");
    });

    it("codex_last: sendText posture-preserving codex -s workspace-write resume --last", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const tmux = mockTmux({ sendText, sendKeys });
      const adapter = new CodexResumeAdapter(tmux);

      await adapter.resume("r99-demo1-impl", "codex_last", null, "/repo");

      expect(sendText).toHaveBeenCalledOnce();
      expect(sendText.mock.calls[0]![1]).toBe("codex -s workspace-write resume --last");
      expect(sendKeys).toHaveBeenCalledOnce();
    });

    it("returns { ok: true } on success", async () => {
      const adapter = new CodexResumeAdapter(mockTmux());
      const result = await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");
      expect(result).toEqual({ ok: true, appliedLaunch: CODEX_FLOOR_EFFECT });
    });

    it("returns { ok: false, code: 'resume_failed' } on failure", async () => {
      const sendText = vi.fn(async () => ({ ok: false as const, code: "session_not_found", message: "err" }));
      const adapter = new CodexResumeAdapter(mockTmux({ sendText }));
      const result = await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("resume_failed");
    });

    it("resume_type=none -> { ok: false, code: 'no_resume' }", async () => {
      const adapter = new CodexResumeAdapter(mockTmux());
      const result = await adapter.resume("r99-demo1-impl", "none", null, "/repo");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("no_resume");
    });

    it("no token + not codex_last -> { ok: false, code: 'no_resume' }", async () => {
      const adapter = new CodexResumeAdapter(mockTmux());
      const result = await adapter.resume("r99-demo1-impl", "codex_id", null, "/repo");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("no_resume");
    });

    it("shell-sensitive token is quoted in command", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const adapter = new CodexResumeAdapter(mockTmux({ sendText, sendKeys }));

      await adapter.resume("r99-demo1-impl", "codex_id", "uuid; rm -rf /", "/repo");

      expect(sendText.mock.calls[0]![1]).toBe("codex -s workspace-write resume 'uuid; rm -rf /'");
    });

    it("profile-bearing resume uses -p flag after preflight passes", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const exec = vi.fn(async () => "[my-profile]\n");
      const adapter = new CodexResumeAdapter(mockTmux({ sendText, sendKeys }), { exec });

      await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo", "my-profile");

      expect(exec).toHaveBeenCalled();
      expect(sendText.mock.calls[0]![1]).toBe("codex -p 'my-profile' resume 'uuid-123'");
    });

    it("profile preflight failure blocks resume before sendText", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const exec = vi.fn(async () => { throw new Error("codex not found"); });
      const adapter = new CodexResumeAdapter(mockTmux({ sendText, sendKeys }), { exec });

      const result = await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo", "bad-profile");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("resume_failed");
        expect(result.message).toContain("Profile preflight failed");
      }
      expect(sendText).not.toHaveBeenCalled();
      expect(sendKeys).not.toHaveBeenCalled();
    });

    it("sendKeys(Enter) fails after sendText -> C-c sent to clear buffer", async () => {
      const sendText = vi.fn(async () => ({ ok: true as const }));
      const sendKeys = vi.fn()
        .mockResolvedValueOnce({ ok: false as const, code: "session_not_found", message: "err" })
        .mockResolvedValueOnce({ ok: true as const });
      const adapter = new CodexResumeAdapter(mockTmux({ sendText, sendKeys }));

      const result = await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("resume_failed");
      expect(sendKeys).toHaveBeenCalledTimes(2);
      expect(sendKeys.mock.calls[1]![1]).toEqual(["C-c"]);
    });

    it("sendText fails -> NO C-c attempt", async () => {
      const sendText = vi.fn(async () => ({ ok: false as const, code: "session_not_found", message: "err" }));
      const sendKeys = vi.fn(async () => ({ ok: true as const }));
      const adapter = new CodexResumeAdapter(mockTmux({ sendText, sendKeys }));

      await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");

      expect(sendKeys).not.toHaveBeenCalled();
    });
  });

  // verifyResume — closes the false-positive `resumed` gap that fire-and-forget
  // left open. Mirrors ClaudeResumeAdapter.verifyResume; uses the existing
  // Codex shape in assessNativeResumeProbe (no new probe patterns).
  describe("verifyResume", () => {
    const fastOptions = { pollMs: 1, maxWaitMs: 5, sleep: async () => {} };

    it("does not claim readiness from a Codex process name alone", async () => {
      const adapter = new CodexResumeAdapter(mockTmux({
        getPaneCommand: async () => "codex", capturePaneContent: async () => "",
      }), fastOptions);
      expect(await adapter.resume("pane", "codex_id", "same-id", "/repo")).toMatchObject({ ok: false, code: "resume_failed" });
    });

    it("probe returns resumed (codex foreground and ready prompt) -> { ok: true }", async () => {
      const getPaneCommand = vi.fn(async () => "codex");
      const capturePaneContent = vi.fn(async () => "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything");
      const adapter = new CodexResumeAdapter(
        mockTmux({ getPaneCommand, capturePaneContent }),
        fastOptions,
      );

      const result = await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");

      expect(result).toEqual({ ok: true, appliedLaunch: CODEX_FLOOR_EFFECT });
      expect(getPaneCommand).toHaveBeenCalled();
    });

    it("probe sees Codex TUI banner (paneContent) -> { ok: true }", async () => {
      const adapter = new CodexResumeAdapter(
        mockTmux({
          getPaneCommand: async () => "node",
          capturePaneContent: async () => "OpenAI Codex (v0.42.0)\n  ›  ready\n  gpt-5 · context",
        }),
        fastOptions,
      );

      const result = await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");

      expect(result).toEqual({ ok: true, appliedLaunch: CODEX_FLOOR_EFFECT });
    });

    it("probe sees `No saved session found` -> { ok: false, code: 'retry_fresh' }", async () => {
      const adapter = new CodexResumeAdapter(
        mockTmux({
          getPaneCommand: async () => "codex",
          capturePaneContent: async () => "Error: No saved session found for that token.\n",
        }),
        fastOptions,
      );

      const result = await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("retry_fresh");
        expect(result.message).toContain("no saved session");
      }
    });

    it("pane falls back to shell after timeout -> { ok: false, code: 'retry_fresh' }", async () => {
      const adapter = new CodexResumeAdapter(
        mockTmux({
          // Inconclusive during polls (unknown command, empty content), then
          // shell on the final assessment.
          getPaneCommand: async () => "zsh",
          capturePaneContent: async () => "",
        }),
        fastOptions,
      );

      const result = await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("retry_fresh");
        expect(result.message).toContain("returned to shell");
      }
    });

    it("probe stays inconclusive (unknown pane) past timeout -> { ok: false, code: 'resume_failed' }", async () => {
      const adapter = new CodexResumeAdapter(
        mockTmux({
          getPaneCommand: async () => "unknown-binary",
          capturePaneContent: async () => "still booting...",
        }),
        fastOptions,
      );

      const result = await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("resume_failed");
        expect(result.message).toContain("timed out");
      }
    });

    it("polls until resumed: first inconclusive, then Codex ready prompt -> { ok: true }", async () => {
      let attempt = 0;
      const adapter = new CodexResumeAdapter(
        mockTmux({
          getPaneCommand: async () => (attempt++ === 0 ? "node" : "codex"),
          capturePaneContent: async () => attempt > 1 ? "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything" : "",
        }),
        { pollMs: 1, maxWaitMs: 50, sleep: async () => {} },
      );

      const result = await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");

      expect(result).toEqual({ ok: true, appliedLaunch: CODEX_FLOOR_EFFECT });
      expect(attempt).toBeGreaterThanOrEqual(2);
    });

    // Codex auth-refusal -> attention_required pass-through. Mirrors
    // ClaudeResumeAdapter.verifyResume's evidence shape (last 12 pane lines).
    // Closes the lifecycle scenario matrix slice's documented Codex deferral.
    it("probe says attention_required (codex auth-refusal) -> { ok: false, code: 'attention_required', evidence }", async () => {
      const refusalPane = [
        "$ codex -s workspace-write resume 019d-token",
        "Error: Your access token could not be refreshed because you have since",
        "logged out or signed in to another account. Please sign in again.",
      ].join("\n");
      const adapter = new CodexResumeAdapter(
        mockTmux({
          getPaneCommand: async () => "zsh",
          capturePaneContent: async () => refusalPane,
        }),
        fastOptions,
      );

      const result = await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("attention_required");
        expect(result.message).toContain("sign in again");
        // Evidence should be the last-12-lines tail of pane content
        // (mirrors claude-resume.ts:97 shape exactly).
        expect((result as { evidence?: string }).evidence).toBeDefined();
        expect((result as { evidence?: string }).evidence).toContain("access token could not be refreshed");
        expect((result as { evidence?: string }).evidence).toContain("Please sign in again");
      }
    });

    it("attention_required does NOT trigger when only access-token phrase present (no operator instruction)", async () => {
      const adapter = new CodexResumeAdapter(
        mockTmux({
          getPaneCommand: async () => "codex",
          capturePaneContent: async () => "debug: access token could not be refreshed (retrying...)\nOpenAI Codex (v0.0.0)\n› Ask Codex to do anything",
        }),
        fastOptions,
      );

      const result = await adapter.resume("r99-demo1-impl", "codex_id", "uuid-123", "/repo");

      // A ready prompt is still present; the auth-refusal pattern requires both anchors.
      expect(result.ok).toBe(true);
    });
  });
});
