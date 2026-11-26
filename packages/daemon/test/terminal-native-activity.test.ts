import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeSessionActivity } from "../src/domain/session-transport.js";
import { verifyWindowsPaneReceiver } from "../src/domain/windows-pane-receiver.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
vi.mock("../src/domain/windows-pane-receiver.js", () => ({ verifyWindowsPaneReceiver: vi.fn() }));

describe("native terminal activity evidence", () => {
  beforeEach(() => { vi.mocked(verifyWindowsPaneReceiver).mockReset(); });
  function fixture(command: string | null, native = true) {
    const getPanePid = vi.fn(async () => 123);
    const adapter = { isNativeWindows: native, getPaneCommand: vi.fn(async () => command), getPanePid } as unknown as TmuxAdapter;
    return { getPanePid, run: () => probeSessionActivity({ sessionName: "owned", runtime: "terminal", attachmentType: "tmux", tmuxAdapter: adapter, binding: { nodeId: "node", occupant: "generation", pane: "psmux:b3duZWQ:%2" } }) };
  }
  it.each(["powershell.exe", "C:\\Program Files\\PowerShell\\7\\pwsh.exe", "CMD.EXE", "bash.exe"])("does not label an unconfirmed shell host %s as running or idle", async command => {
    vi.mocked(verifyWindowsPaneReceiver).mockResolvedValue(false);
    expect(await fixture(command).run()).toMatchObject({ state: "unknown", reason: "unsupported_runtime" });
  });
  it("reports running only with the bound pane's verified console receiver", async () => {
    const f = fixture("powershell.exe");
    vi.mocked(verifyWindowsPaneReceiver).mockResolvedValue(true);
    expect(await f.run()).toMatchObject({ state: "running", reason: "foreground_command", evidence: "powershell.exe" });
    const input = vi.mocked(verifyWindowsPaneReceiver).mock.calls[0]![0];
    expect(input.target).toBe("psmux:b3duZWQ:%2");
    expect(await input.getPanePid(input.target)).toBe(123);
    expect(f.getPanePid).toHaveBeenCalledWith("psmux:b3duZWQ:%2");
  });
  it("keeps unavailable receiver observation unknown", async () => {
    vi.mocked(verifyWindowsPaneReceiver).mockRejectedValue(new Error("unavailable"));
    expect(await fixture("powershell.exe").run()).toMatchObject({ state: "unknown", reason: "capture_failed" });
  });
  it.each([["bash", "unknown"], ["node", "running"], [null, "unknown"]])("retains POSIX command classification for %s", async (command, state) => {
    expect(await fixture(command, false).run()).toMatchObject({ state });
    expect(verifyWindowsPaneReceiver).not.toHaveBeenCalled();
  });
});
