import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

// #1477 section 1 at the adapter: an auto-mode Claude whose banner has scrolled out of the capture is
// ready only on proof of the launched process. A managed launch through a user's own `#!` wrapper that
// exec's the real binary is proved by that binary's OS executable path, pinned from the first proof.
const token = "00000000-0000-4000-8000-000000001477";
const autoScreen = "Restored conversation\n─────────\n❯ \n─────────\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents\n";
const startedAt = "Mon Oct 19 09:00:00 2026";
const wrapper = "/home/user/.local/bin/claude";
const binary = "/home/user/.local/share/mise/installs/claude/2.1.302/claude";
const name = "seat@rig";

const rowsWith = (patch: Partial<NativeProcessRow> = {}): NativeProcessRow[] => [
  { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "-bash", startedAt },
  { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "sh", command: "/bin/sh fixture-launch.txt", startedAt },
  { pid: 102, ppid: 101, pgid: 101, tpgid: 101, executableName: "claude", executablePath: binary, startedAt,
    command: `${binary} --permission-mode auto --resume ${token} --name ${name}`, ...patch },
];

function seat(launch: { executable: string; executableIsScript: boolean }) {
  let rows = rowsWith();
  const listProcesses = vi.fn(async () => rows);
  const tmux = {
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "sh"),
    capturePaneContent: vi.fn(async () => autoScreen),
    getPanePid: vi.fn(async () => 100),
    listPanes: vi.fn(async () => [{ id: "%1" }]),
    sendShellCommand: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  } as unknown as TmuxAdapter;
  const adapter = new ClaudeCodeAdapter({ tmux, listProcesses, sleep: async () => {}, sessionIdFactory: () => token,
    claudeManagedLaunch: { prepare: async () => ({ command: (args: readonly string[]) => `claude ${args.join(" ")}`,
      assertCurrent: () => {}, configDir: "/fixture", ...launch }) } as never,
    fsOps: { exists: () => false, readFile: () => "", writeFile: () => {}, mkdirp: () => {}, copyFile: () => {} } });
  const binding: NodeBinding = { id: "binding", nodeId: "node", tmuxSession: name, tmuxPane: "%1", tmuxWindow: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/fixture", permissionMode: "auto" };
  return { adapter, binding, listProcesses, tmux, set: (next: NativeProcessRow[]) => { rows = next; } };
}
const script = { executable: wrapper, executableIsScript: true };

describe("a Claude launched through a #! wrapper script", () => {
  it("resumes ready, recording the process the launch proved", async () => {
    const { adapter, binding } = seat(script);
    expect(await adapter.launchHarness(binding, { name, resumeToken: token })).toMatchObject({
      ok: true, resumeToken: token, launchedProcess: { pid: 102, startedAt } });
  });

  it("then holds every later readiness check to the executable path it pinned", async () => {
    const { adapter, binding, set } = seat(script);
    await adapter.launchHarness(binding, { name, resumeToken: token });
    expect((await adapter.checkReady(binding)).ready).toBe(true);
    // Same process, another executable path: no longer the pinned process.
    set(rowsWith({ executablePath: "/home/user/other/installs/claude/2.1.302/claude" }));
    expect(await adapter.checkReady(binding)).toMatchObject({ ready: false, code: "claude_auto_identity_required" });
    // The OS path unreadable: a name alone is not enough.
    set(rowsWith({ executablePath: undefined }));
    expect((await adapter.checkReady(binding)).ready).toBe(false);
    set(rowsWith());
    expect((await adapter.checkReady(binding)).ready).toBe(true);
  });

  it.each([["pid", { pid: 103 }], ["start time", { startedAt: "Mon Oct 19 09:00:09 2026" }]] as const)(
    "refuses a process whose %s differs from the pinned one, with the same executable path", async (_name, patch) => {
      const { adapter, binding, set } = seat(script);
      await adapter.launchHarness(binding, { name, resumeToken: token });
      expect((await adapter.checkReady(binding)).ready).toBe(true);
      set(rowsWith(patch));
      expect(await adapter.checkReady(binding)).toMatchObject({ ready: false, code: "claude_auto_identity_required" });
      set(rowsWith());
      expect((await adapter.checkReady(binding)).ready).toBe(true);
    });

  it("verifies only the process that was pinned when two checks overlap before any pin", async () => {
    const { adapter, binding, listProcesses, tmux } = seat(script);
    await adapter.launchHarness(binding, { name });
    const other = "/home/user/other/installs/claude/2.1.302/claude";
    // Each check holds at its last await before it can pin, the pane PID read against the session name.
    const held: (() => void)[] = [];
    const reached: (() => void)[] = [];
    (tmux.getPanePid as ReturnType<typeof vi.fn>).mockImplementation(async (target: string) => {
      if (target !== name) return 100;
      await new Promise<void>(resolve => { held.push(resolve); reached.shift()?.(); });
      return 100;
    });
    const waitHeld = () => new Promise<void>(resolve => { if (held.length > 0) resolve(); else reached.push(resolve); });
    listProcesses.mockImplementation(async () => rowsWith());
    const first = adapter.checkReady(binding);
    await waitHeld();
    // The second check saw another process twice; it is the later of the two to reach the pin.
    listProcesses.mockImplementation(async () => rowsWith({ executablePath: other }));
    const second = adapter.checkReady(binding);
    await new Promise<void>(resolve => { const poll = () => held.length === 2 ? resolve() : setTimeout(poll, 1); poll(); });
    held[0]!();
    expect((await first).ready).toBe(true);
    held[1]!();
    expect(await second).toMatchObject({ ready: false, code: "claude_auto_identity_required" });
  });

  it("pins nothing from a first sample that its second sample does not confirm", async () => {
    const { adapter, binding, listProcesses, set } = seat(script);
    await adapter.launchHarness(binding, { name });
    const other = "/home/user/other/installs/claude/2.1.302/claude";
    let reads = 0;
    listProcesses.mockImplementation(async () => (reads++ % 2 === 0 ? rowsWith() : rowsWith({ executablePath: other })));
    expect((await adapter.checkReady(binding)).ready).toBe(false);
    // Had the unconfirmed first sample been pinned, the process that then holds steady could never be proved.
    listProcesses.mockImplementation(async () => rowsWith({ executablePath: other }));
    expect((await adapter.checkReady(binding)).ready).toBe(true);
    set(rowsWith());
    listProcesses.mockImplementation(async () => rowsWith());
    expect((await adapter.checkReady(binding)).ready).toBe(false);
  });

  it("does not resume on a wrong conversation", async () => {
    const { adapter, binding, set } = seat(script);
    set(rowsWith({ command: `${binary} --permission-mode auto --resume other --name ${name}` }));
    expect(await adapter.launchHarness(binding, { name, resumeToken: token })).toMatchObject({ ok: false, recovery: "attention_required" });
  });
});

describe("a Claude launched from a native binary", () => {
  it("keeps the exact-path rule: a process whose path differs from the frozen one is not proved", async () => {
    const { adapter, binding } = seat({ executable: wrapper, executableIsScript: false });
    expect(await adapter.launchHarness(binding, { name, resumeToken: token })).toMatchObject({ ok: false, recovery: "attention_required" });
  });

  it("is proved when its path is the frozen one", async () => {
    const { adapter, binding } = seat({ executable: binary, executableIsScript: false });
    expect(await adapter.launchHarness(binding, { name, resumeToken: token })).toMatchObject({ ok: true });
  });
});
