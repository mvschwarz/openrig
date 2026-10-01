import { describe, expect, it, vi } from "vitest";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { CursorResumeAdapter } from "../src/adapters/cursor-resume.js";

const CHAT_ID = "167733b3-080d-4eb0-a30a-7d22c40b5195";
const READY = "  Cursor Agent\n  v2026.09.28-64d2043\n  → Plan, search, build anything\n";

function tmux(screens: string[]) {
  let i = 0;
  return {
    sendShellCommand: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => "cursor-agent"),
    capturePaneContent: vi.fn(async () => screens[Math.min(i++, screens.length - 1)]!),
  } as unknown as TmuxAdapter & { sendShellCommand: ReturnType<typeof vi.fn> };
}

// In-memory fs so no test writes the chat-launch record to the real filesystem.
function memFsOps(files: Record<string, string> = {}) {
  return {
    files,
    readFile: (p: string) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]!; },
    writeFile: (p: string, c: string) => { files[p] = c; },
    exists: (p: string) => p in files,
  };
}

const baseOpts = { stateRoot: "/h/state/cursor", sleep: async () => {}, pollMs: 1, maxWaitMs: 50 };
const opts = () => ({ ...baseOpts, fsOps: memFsOps() });

describe("CursorResumeAdapter", () => {
  it("only claims cursor_chat_id tokens", () => {
    const a = new CursorResumeAdapter(tmux([READY]), opts());
    expect(a.canResume("cursor_chat_id", CHAT_ID)).toBe(true);
    expect(a.canResume("cursor_chat_id", null)).toBe(false);
    expect(a.canResume("codex_id", CHAT_ID)).toBe(false);
  });

  it("relaunches the same chat in the seat's isolated config and waits for the prompt", async () => {
    const t = tmux(["", READY]);
    const result = await new CursorResumeAdapter(t, opts()).resume("s@r", "cursor_chat_id", CHAT_ID, "/work", "node-1", "grok-4.7-high", undefined, "auto_review");
    expect(result).toEqual({ ok: true });
    const cmd = t.sendShellCommand.mock.calls[0]![1] as string;
    expect(cmd).toContain(`--resume '${CHAT_ID}'`);
    expect(cmd).toContain("CURSOR_CONFIG_DIR='/h/state/cursor/node-1'");
    expect(cmd).toMatch(/--auto-review$/);
  });

  it("resets a persisted auto-review approval mode before relaunching without auto_review", async () => {
    const config = "/h/state/cursor/node-1/cli-config.json";
    const files: Record<string, string> = { [config]: JSON.stringify({ approvalMode: "auto-review", model: { modelId: "m" } }) };
    const fsOps = memFsOps(files);
    const t = tmux([READY]);
    const result = await new CursorResumeAdapter(t, { ...baseOpts, fsOps }).resume("s@r", "cursor_chat_id", CHAT_ID, "/work", "node-1", null, "floor");
    expect(result).toEqual({ ok: true });
    expect(JSON.parse(files[config]!)).toEqual({ approvalMode: "allowlist", model: { modelId: "m" } });
    expect(t.sendShellCommand.mock.calls[0]![1]).not.toContain("--auto-review");
  });

  it("surfaces a trust gate as attention_required", async () => {
    const result = await new CursorResumeAdapter(tmux(["⚠ Workspace Trust Required\n▶ [a] Trust this workspace"]), opts())
      .resume("s@r", "cursor_chat_id", CHAT_ID, "/work", "node-1");
    expect(result).toMatchObject({ ok: false, code: "attention_required" });
  });

  it("fails after the wait when the prompt never appears", async () => {
    const result = await new CursorResumeAdapter(tmux([""]), opts()).resume("s@r", "cursor_chat_id", CHAT_ID, "/work", "node-1");
    expect(result).toMatchObject({ ok: false, code: "resume_failed" });
  });

  it("never quotes the resume token in the timeout message", async () => {
    const result = await new CursorResumeAdapter(tmux([""]), opts()).resume("s@r", "cursor_chat_id", CHAT_ID, "/work", "node-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain(CHAT_ID);
  });

  describe("per-chat approval mode sidecar", () => {
    const SIDECAR = "/h/state/cursor/node-1/openrig-chat-launch.json";
    it("refuses to resume a chat whose approval mode changed, without sending anything", async () => {
      const fsOps = memFsOps({ [SIDECAR]: JSON.stringify({ chatId: CHAT_ID, approvalArg: " --auto-review" }) });
      const t = tmux([READY]);
      const result = await new CursorResumeAdapter(t, { ...baseOpts, fsOps }).resume("s@r", "cursor_chat_id", CHAT_ID, "/work", "node-1", null, "floor");
      expect(result).toEqual({
        ok: false,
        code: "retry_fresh",
        message: "Cursor permission mode changed since this chat last ran; a fresh chat is required for the new mode to apply.",
      });
      expect(t.sendShellCommand).not.toHaveBeenCalled();
    });

    it("resumes an unchanged chat and records the approval arg it launched with", async () => {
      const fsOps = memFsOps({ [SIDECAR]: JSON.stringify({ chatId: CHAT_ID, approvalArg: " --auto-review" }) });
      const t = tmux([READY]);
      const result = await new CursorResumeAdapter(t, { ...baseOpts, fsOps }).resume("s@r", "cursor_chat_id", CHAT_ID, "/work", "node-1", null, "floor", "auto_review");
      expect(result).toEqual({ ok: true });
      expect(t.sendShellCommand).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fsOps.files[SIDECAR]!)).toEqual({ chatId: CHAT_ID, approvalArg: " --auto-review" });
    });

    it("resumes and writes the sidecar when none exists", async () => {
      const fsOps = memFsOps({});
      const result = await new CursorResumeAdapter(tmux([READY]), { ...baseOpts, fsOps }).resume("s@r", "cursor_chat_id", CHAT_ID, "/work", "node-1", null, "floor");
      expect(result).toEqual({ ok: true });
      expect(JSON.parse(fsOps.files[SIDECAR]!)).toEqual({ chatId: CHAT_ID, approvalArg: "" });
    });
  });
});
