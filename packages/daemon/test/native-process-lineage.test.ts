import { describe, expect, it, vi } from "vitest";
import { findExactNativeResumeProcess, observeClaudePaneStartedAt, observeClaudeDelivery, verifyClaudePaneProcess, verifyCodexPaneProcess, type NativeProcessRow } from "../src/domain/native-process-lineage.js";

import { operationalLaunchArgs } from "../src/adapters/kernel-authority.js";

const token = "00000000-0000-7000-8000-000000000001";
const startedAt = "Sat Jan  1 12:00:00 2000";
function rows(): NativeProcessRow[] {
  return [
    { pid: 10, ppid: 1, pgid: 10, tpgid: 11, executableName: "zsh", command: "-zsh", startedAt },
    { pid: 11, ppid: 10, pgid: 11, tpgid: 11, executableName: "bash", command: "/bin/sh /tmp/openrig-tmux-send.txt", startedAt },
    { pid: 12, ppid: 11, pgid: 11, tpgid: 11, executableName: "node", command: `node /opt/bin/codex resume ${token}`, startedAt },
    { pid: 13, ppid: 12, pgid: 11, tpgid: 11, executableName: "codex", command: `/opt/native/codex -p resume resume --add-dir /tmp/state ${token}`, startedAt },
  ];
}
const check = (listProcesses: () => NativeProcessRow[] | Promise<NativeProcessRow[]>, overrides = {}) => verifyCodexPaneProcess({
  target: "%1", tmux: { getPanePid: async () => 10 }, listProcesses, expectedToken: token, requireResume: true, ...overrides,
});

describe("joined native Codex identity", () => {
  it("selects the unique native process, not its Node wrapper", async () => {
    expect((await check(rows))?.process.pid).toBe(13);
    expect(findExactNativeResumeProcess(rows(), 10, "codex", token)?.pid).toBe(13);
  });
  it("proves direct-native resume", async () => {
    expect((await check(() => [{ ...rows()[3]!, pid: 10, ppid: 1 }]))?.process.pid).toBe(10);
  });
  it("distinguishes fresh/non-strict runtime proof from exact resume", async () => {
    const fresh = () => rows().map(r => r.pid === 13 ? { ...r, command: "/opt/native/codex -m model" } : r);
    expect(await check(fresh)).toBeNull();
    expect(await check(fresh, { requireResume: false })).not.toBeNull();
    expect(await check(rows, { requireResume: false, expectedToken: "different" })).toBeNull();
    expect(await check(rows, { requireResume: true, expectedToken: null })).toBeNull();
    expect(await check(rows, { requireResume: false, expectedToken: null })).toBeNull();
    expect(await check(() => rows().map(r => r.pid === 13 ? { ...r, command: "/opt/native/codex resume --last" } : r), { requireResume: false, expectedToken: null })).toBeNull();
  });
  const controls: [string, (r: NativeProcessRow[]) => NativeProcessRow[]][] = [
    ["wrong UUID", r => r.map(x => x.pid === 13 ? { ...x, command: "/opt/native/codex resume other" } : x)],
    ["missing UUID", r => r.map(x => x.pid === 13 ? { ...x, command: "/opt/native/codex resume" } : x)],
    ["token only in prompt", r => r.map(x => x.pid === 13 ? { ...x, command: `/opt/native/codex resume other ${token}` } : x)],
    ["wrong OS executable", r => r.map(x => x.pid === 13 ? { ...x, executableName: "printf" } : x)],
    ["argv-only executable", r => r.map(x => x.pid === 13 ? { ...x, command: `/bin/echo codex resume ${token}` } : x)],
    ["unrelated descendant", r => r.map(x => x.pid === 13 ? { ...x, ppid: 999 } : x)],
    ["background native", r => r.map(x => x.pid === 13 ? { ...x, pgid: 99 } : x)],
    ["conflicting foreground", r => r.map(x => x.pid === 13 ? { ...x, tpgid: 99 } : x)],
    ["missing root", r => r.slice(1)],
    ["missing ancestry", r => r.filter(x => x.pid !== 11)],
    ["cyclic ancestry", r => r.map(x => x.pid === 11 ? { ...x, ppid: 13 } : x)],
    ["multiple native candidates", r => [...r, { ...r[3]!, pid: 14 }]],
    ["duplicate PID", r => [...r, r[3]!]],
    ["missing start time", r => r.map(x => ({ ...x, startedAt: undefined }))],
    ["missing group", r => r.map(x => ({ ...x, tpgid: undefined }))],
    ["exited native", r => r.filter(x => x.pid !== 13)],
  ];
  it.each(controls)("refuses %s", async (_name, mutate) => {
    expect(await check(() => mutate(rows()))).toBeNull();
  });
  it.each(["startedAt", "command", "ppid", "pgid"] as const)("refuses a changed native %s between observations", async (field) => {
    const changed = rows().map(r => r.pid === 13 ? { ...r, [field]: field === "startedAt" ? "Sat Jan  1 12:00:01 2000" : field === "command" ? r.command + " --verbose" : 99 } : r);
    expect(await check(vi.fn().mockResolvedValueOnce(rows()).mockResolvedValueOnce(changed))).toBeNull();
  });
  it("refuses a reused pane PID even when the native PID is unchanged", async () => {
    const changed = rows().map(r => r.pid === 10 ? { ...r, startedAt: "Sat Jan  1 12:00:01 2000" } : r);
    expect(await check(vi.fn().mockResolvedValueOnce(rows()).mockResolvedValueOnce(changed))).toBeNull();
  });
  it("refuses a changed or missing pane and process observation failures", async () => {
    expect(await check(rows, { tmux: { getPanePid: vi.fn().mockResolvedValueOnce(10).mockResolvedValueOnce(11) } })).toBeNull();
    expect(await check(rows, { tmux: { getPanePid: async () => null } })).toBeNull();
    expect(await check(async () => { throw new Error("ps failed"); })).toBeNull();
  });
  it("retains the existing Claude exact-token contract", () => {
    expect(findExactNativeResumeProcess([{ pid: 10, ppid: 1, command: `claude --resume ${token}` }], 10, "claude-code", token)?.pid).toBe(10);
    expect(findExactNativeResumeProcess([{ pid: 10, ppid: 1, command: "claude --resume wrong" }], 10, "claude-code", token)).toBeNull();
  });
});

describe("observeClaudePaneStartedAt", () => {
  const claudeStart = "Fri Oct  2 11:00:00 2026";
  const claudeRows = (extra: NativeProcessRow[] = []): NativeProcessRow[] => [
    { pid: 20, ppid: 1, pgid: 20, tpgid: 21, executableName: "zsh", command: "-zsh", startedAt },
    { pid: 21, ppid: 20, pgid: 21, tpgid: 21, executableName: "claude", command: "claude --name seat@rig", startedAt: claudeStart },
    ...extra,
  ];
  const observe = (list: NativeProcessRow[], panePid: number | null = 20) =>
    observeClaudePaneStartedAt({ target: "seat@rig", tmux: { getPanePid: async () => panePid }, listProcesses: () => list });

  it("returns the start time of the one Claude process in the pane's foreground, without a token", async () => {
    expect(await observe(claudeRows())).toBe(claudeStart);
  });

  it("is unknown when the pane, the process or a single candidate cannot be established", async () => {
    expect(await observe(claudeRows(), null)).toBeNull();
    expect(await observe(claudeRows().slice(0, 1))).toBeNull();
    expect(await observe(claudeRows([{ pid: 22, ppid: 20, pgid: 21, tpgid: 21, executableName: "claude", command: "claude", startedAt: claudeStart }]))).toBeNull();
  });
});

describe("Claude identity with inline settings in ps output", () => {
  const settings = [
    ["kernel", operationalLaunchArgs("claude-code", { kernelAuthority: true })[1]!],
    ["team", operationalLaunchArgs("claude-code", { teamPermissionDefault: true })[1]!],
    ["escaped quotes and hooks", JSON.stringify({
      permissions: { allow: ["Bash(npm run test:*)"] },
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: 'node "/fixture with spaces/check.cjs" --label "it\'s fine"', timeout: 5 }] }] },
    })],
  ];
  function input(args: string) {
    const list = [
      { pid: 20, ppid: 1, pgid: 20, tpgid: 21, executableName: "zsh", command: "-zsh", startedAt },
      { pid: 21, ppid: 20, pgid: 21, tpgid: 21, executableName: "claude",
        command: `claude --permission-mode acceptEdits ${args} --name seat@rig`, startedAt },
    ];
    return { target: "%1", tmux: { getPanePid: async () => 20 }, listProcesses: async () => list, expectedToken: token };
  }
  for (const [name, value] of settings) {
    for (const flag of ["--session-id", "--resume"]) {
      it.each(["before", "after"])(`${name}: ${flag} %s settings stays exact for identity and delivery`, async order => {
        // ps joins argv without putting shell quotes around the JSON argument.
        const identity = `${flag} ${token}`, option = `--settings ${value}`;
        const args = order === "before" ? `${identity} ${option}` : `${option} ${identity}`;
        const actual = input(args);
        expect((await verifyClaudePaneProcess(actual))?.process.pid).toBe(21);
        expect((await observeClaudeDelivery(actual)).state).toBe("verified");
        expect(await verifyClaudePaneProcess({ ...actual, expectedToken: "different" })).toBeNull();
        expect((await observeClaudeDelivery({ ...actual, expectedToken: "different" })).state).toBe("unknown");
      });
    }
  }
  it.each([
    `--settings '/fixture/settings with spaces.json' --session-id '${token}'`,
    `--settings="/fixture/settings with spaces.json" --session-id ${token}`,
    `--settings '{"label":"two words"}' --resume "${token}"`,
    `--settings={"label":"two words"} --session-id=${token}`,
    `--settings /fixture/settings.json --session-id ${token}`,
  ])("accepts quoted and file settings: %s", async args => {
    expect((await verifyClaudePaneProcess(input(args)))?.process.pid).toBe(21);
    expect((await observeClaudeDelivery(input(args))).state).toBe("verified");
  });
  it.each([
    `--settings ${JSON.stringify({ label: `two words --session-id ${token}` })}`,
    `--settings ${settings[0]![1]} --session-id ${token} --session-id different`,
    `--settings ${settings[1]![1]} --session-id ${token} --unknown`,
    `--session-id ${token} --settings '{"label":"unterminated"}`,
    `--session-id ${token} --settings {"label":"unterminated}`,
  ])("does not promote ambiguous or incomplete argv: %s", async args => {
    expect(await verifyClaudePaneProcess(input(args))).toBeNull();
    expect((await observeClaudeDelivery(input(args))).state).not.toBe("verified");
  });
});
