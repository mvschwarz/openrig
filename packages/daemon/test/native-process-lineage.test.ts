import { describe, expect, it, vi } from "vitest";
import { findExactNativeResumeProcess, observeClaudePaneStartedAt, verifyAgyPaneProcess, verifyCodexPaneProcess, type NativeProcessRow } from "../src/domain/native-process-lineage.js";

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

describe("joined native agy identity", () => {
  // bash (pane pid) -> /bin/sh staged launch script -> agy, the shape OpenRig's launch produces.
  const agyRows = (): NativeProcessRow[] => [
    { pid: 30, ppid: 1, pgid: 30, tpgid: 31, executableName: "bash", command: "-bash", startedAt },
    { pid: 31, ppid: 30, pgid: 31, tpgid: 31, executableName: "sh", command: "/bin/sh /tmp/openrig-tmux-send-abc.txt", startedAt },
    { pid: 32, ppid: 31, pgid: 31, tpgid: 31, executableName: "agy", command: "/usr/local/bin/agy --dangerously-skip-permissions --model claude-sonnet-5-5", startedAt },
  ];
  const checkAgy = (listProcesses: () => NativeProcessRow[] | Promise<NativeProcessRow[]>, overrides = {}) => verifyAgyPaneProcess({
    target: "%3", tmux: { getPanePid: async () => 30 }, listProcesses, ...overrides,
  });

  it("proves the agy behind the staged sh script without a resume token", async () => {
    expect((await checkAgy(agyRows))?.process.pid).toBe(32);
  });
  it("proves an agy launched with --conversation when the token matches, and refuses a different one", async () => {
    const withConversation = () => agyRows().map(r => r.pid === 32 ? { ...r, command: r.command + " --conversation conv-1" } : r);
    expect((await checkAgy(withConversation, { expectedToken: "conv-1" }))?.process.pid).toBe(32);
    expect(await checkAgy(withConversation, { expectedToken: "conv-2" })).toBeNull();
  });
  const refusals: [string, (r: NativeProcessRow[]) => NativeProcessRow[]][] = [
    ["a bare idle shell", r => [{ ...r[0]!, tpgid: 30 }]],
    ["two agy candidates", r => [...r, { ...r[2]!, pid: 33 }]],
    ["an agy that is not a pane descendant", r => r.map(x => x.pid === 32 ? { ...x, ppid: 999 } : x)],
    ["an agy in a different process group", r => r.map(x => x.pid === 32 ? { ...x, pgid: 99 } : x)],
    ["an agy that is not the foreground group", r => r.map(x => x.pid === 32 ? { ...x, tpgid: 99 } : x)],
    ["a non-agy executable whose argv names agy", r => r.map(x => x.pid === 32 ? { ...x, executableName: "printf" } : x)],
    ["an agy name only in a script argument", r => r.map(x => x.pid === 32 ? { ...x, executableName: "node", command: "/usr/bin/node /opt/bin/agy" } : x)],
    ["an exited agy", r => r.filter(x => x.pid !== 32)],
  ];
  it.each(refusals)("refuses %s", async (_name, mutate) => {
    expect(await checkAgy(() => mutate(agyRows()))).toBeNull();
  });
  it("refuses a changed agy between observations", async () => {
    const changed = agyRows().map(r => r.pid === 32 ? { ...r, startedAt: "Sat Jan  1 12:00:01 2000" } : r);
    expect(await checkAgy(vi.fn().mockResolvedValueOnce(agyRows()).mockResolvedValueOnce(changed))).toBeNull();
  });
  it("does not accept a codex process as agy", async () => {
    expect(await checkAgy(() => agyRows().map(r => r.pid === 32 ? { ...r, executableName: "codex", command: "/opt/native/codex" } : r))).toBeNull();
  });
});
