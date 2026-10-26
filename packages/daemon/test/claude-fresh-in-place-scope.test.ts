import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { CLAUDE_BYPASS_CONSENT } from "./fixtures/claude-bypass-consent.js";

const token = "22222222-2222-4222-8222-222222222222";
const history = "Claude Code v2.1.303\n❯ predecessor finished turn\n  ⏵⏵ accept edits on (shift+tab to cycle)";
const binding: NodeBinding = { id: "binding", nodeId: "node", tmuxSession: "seat", tmuxPane: "%9",
  tmuxWindow: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/fixture", launchGeneration: 7 };
function fixture() {
  const capturePaneScreen = vi.fn(async (): Promise<string | null> => "operator@host$ ");
  const capturePaneContent = vi.fn(async () => history);
  const getPaneCommand = vi.fn(async () => "zsh");
  const getPanePid = vi.fn(async (): Promise<number | null> => 100);
  const listProcesses = vi.fn((): NativeProcessRow[] => { throw new Error("ps unavailable"); });
  const tmux = { hasSession: vi.fn(async () => true), getPaneCommand, capturePaneContent, capturePaneScreen,
    sendText: vi.fn(async () => ({ ok: true })), sendKeys: vi.fn(async () => ({ ok: true })),
    listPanes: vi.fn(async () => [{ id: "%9" }]), getPanePid } as unknown as TmuxAdapter;
  const fail = () => { throw new Error("unexpected filesystem access"); };
  const adapter = new ClaudeCodeAdapter({ tmux, listProcesses, sessionIdFactory: () => token, sleep: async () => {},
    fsOps: { exists: () => false, readFile: fail, writeFile: fail, mkdirp: fail, copyFile: fail } });
  return { adapter, capturePaneScreen, capturePaneContent, getPaneCommand, getPanePid, listProcesses };
}
const launch = (adapter: ClaudeCodeAdapter, opts: Partial<Parameters<RuntimeAdapter["launchHarness"]>[1]> = {}) =>
  adapter.launchHarness(binding, { name: "seat", freshInPlace: true, ...opts });

// Claude Code 2.1.309's Resume session picker, from dev50-qa's native capture of a bare `claude --resume` (100×80).
const resumePicker = (JSON.parse(readFileSync(new URL("./fixtures/claude-resume-picker-2.1.309.json", import.meta.url), "utf8")) as
  Record<string, string>).first100x80!;

describe("Claude's Resume session picker is not ready", () => {
  it.each(["adopted", "resume"])("checkReady waits for a person at the picker (%s)", async mode => {
    const f = fixture();
    f.capturePaneContent.mockResolvedValue(resumePicker);
    f.getPaneCommand.mockResolvedValue("claude");
    if (mode === "resume") await launch(f.adapter, { resumeToken: token });
    expect(await f.adapter.checkReady(binding)).toMatchObject({ ready: false, code: "claude_resume_selection_prompt" });
  });
});

describe("fresh in-place readiness scope and fallback", () => {
  it.each(["adopted", "ordinary-fresh", "resume", "fork"])("preserves %s readiness without reading the current frame", async mode => {
    const f = fixture();
    if (mode === "ordinary-fresh") await f.adapter.launchHarness(binding, { name: "seat" });
    if (mode === "resume") await launch(f.adapter, { resumeToken: token });
    if (mode === "fork") await launch(f.adapter, { forkSource: { kind: "native_id", value: token } });
    expect(await f.adapter.checkReady(binding)).toEqual({ ready: true });
    expect(f.capturePaneScreen).not.toHaveBeenCalled();
  });

  it.each(["id", "nodeId", "tmuxSession", "tmuxPane", "launchGeneration"] as const)("does not reuse an intent for a different %s", async field => {
    const f = fixture();
    await launch(f.adapter);
    const changed = { ...binding, [field]: field === "launchGeneration" ? 8 : "changed" };
    expect(await f.adapter.checkReady(changed)).toEqual({ ready: true });
    expect(f.capturePaneScreen).not.toHaveBeenCalled();
  });

  it.each([null, "", "  "])("retains old admission when the current frame is unavailable (%s)", async screen => {
    const f = fixture();
    f.capturePaneScreen.mockResolvedValue(screen);
    await launch(f.adapter);
    expect(await f.adapter.checkReady(binding)).toEqual({ ready: true });
    expect(f.capturePaneScreen).toHaveBeenCalledWith("%9");
  });
  it("retains old admission on a failed screen observation", async () => {
    const f = fixture();
    f.capturePaneScreen.mockRejectedValue(new Error("capture unavailable"));
    await launch(f.adapter);
    expect(await f.adapter.checkReady(binding)).toEqual({ ready: true });
  });

  it.each([
    ["Accessing workspace:\nYes, I trust this folder", "trust_gate"],
    ["new MCP servers found in .mcp.json\nSelect any you wish to enable\nEnter to confirm", "mcp_gate"],
    [CLAUDE_BYPASS_CONSENT, "bypass_consent_gate"],
    ["How would you like to resume?\n❯ Resume from summary\n  Resume full session as-is", "claude_resume_selection_prompt"],
    [resumePicker, "claude_resume_selection_prompt"],
    ["● Not logged in · Please run /login\n❯\u00a0", "login_required"],
    ["No conversation found", "no_conversation_found"],
  ])("does not replace a visible gate with the history fallback: %s", async (screen, code) => {
    const f = fixture();
    f.capturePaneScreen.mockResolvedValue(screen);
    await launch(f.adapter);
    expect(await f.adapter.checkReady(binding)).toMatchObject({ ready: false, code });
  });

  it("does not promote a historically blocked result from a ready-looking current frame", async () => {
    const f = fixture();
    f.capturePaneContent.mockResolvedValue("Accessing workspace:\nYes, I trust this folder");
    f.capturePaneScreen.mockResolvedValue(history);
    await launch(f.adapter);
    expect(await f.adapter.checkReady(binding)).toMatchObject({ ready: false, code: "trust_gate" });
    expect(f.capturePaneScreen).not.toHaveBeenCalled();
  });

  it.each(["claude", "claude --unrecognized-option opaque --session-id apparent-token"])("keeps unknown identity unknown: %s", async command => {
    for (const screen of [null, history,
      "Restored conversation\n─────────\n❯ \n─────────\n  ⏵⏵ auto mode on (shift+tab to cycle)",
      "Restored conversation\n─────────\n❯ \n─────────\n  ⏵⏵ accept edits on (shift+tab to cycle)"]) {
      const f = fixture();
      f.getPaneCommand.mockResolvedValue("sh");
      f.capturePaneScreen.mockResolvedValue(screen);
      const startedAt = "Mon Oct 19 21:30:00 2026";
      f.listProcesses.mockReturnValue([
        { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "-bash", startedAt },
        { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "claude", command, startedAt },
      ]);
      await launch(f.adapter);
      expect(await f.adapter.checkReady(binding), JSON.stringify({ command, screen })).toEqual({ ready: true });
    }
  });

  it.each(["missing-pane-pid", "missing-pane-row", "background-claude"])("does not claim absence from incomplete pane evidence: %s", async mode => {
    const f = fixture();
    f.getPaneCommand.mockResolvedValue("sh");
    f.capturePaneScreen.mockResolvedValue("❯ ");
    const startedAt = "Mon Oct 19 21:30:00 2026";
    f.listProcesses.mockReturnValue(mode === "missing-pane-row" ? [] : [
      { pid: 100, ppid: 1, pgid: 100, tpgid: 100, executableName: "bash", command: "-bash", startedAt },
      ...(mode === "background-claude" ? [
        { pid: 101, ppid: 100, pgid: 101, tpgid: 100, executableName: "claude", command: "claude", startedAt },
      ] : []),
    ]);
    if (mode === "missing-pane-pid") f.getPanePid.mockResolvedValue(null);
    await launch(f.adapter);
    expect(await f.adapter.checkReady(binding)).toEqual({ ready: true });
  });

  it("does not use unavailable-screen fallback for a positively different launch identity", async () => {
    const f = fixture();
    f.capturePaneScreen.mockResolvedValue(null);
    const startedAt = "Mon Oct 19 21:30:00 2026";
    f.listProcesses.mockImplementation(() => [
      { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "-bash", startedAt },
      { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "claude", command: "claude --session-id different-token", startedAt },
    ]);
    await launch(f.adapter);
    expect(await f.adapter.checkReady(binding)).toMatchObject({ ready: false, code: "claude_launch_identity_conflict" });
  });

  it("keeps a positively different runtime blocked despite unavailable screen evidence", async () => {
    const f = fixture();
    f.capturePaneScreen.mockResolvedValue(null);
    const startedAt = "Mon Oct 19 21:30:00 2026";
    f.listProcesses.mockReturnValue([
      { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "-bash", startedAt },
      { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "codex", command: "codex resume other-token", startedAt },
    ]);
    await launch(f.adapter);
    expect(await f.adapter.checkReady(binding)).toMatchObject({ ready: false, code: "claude_launch_identity_conflict" });
  });

  it("does not carry a ready observation across a replacement launch", async () => {
    const f = fixture();
    await launch(f.adapter);
    f.capturePaneScreen.mockImplementation(async () => {
      await f.adapter.launchHarness(binding, { name: "replacement" });
      return history;
    });
    expect(await f.adapter.checkReady(binding)).toMatchObject({ ready: false, code: "awaiting_runtime" });
  });
});
