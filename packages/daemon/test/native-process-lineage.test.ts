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
  it.each([
    `resume ${token} --add-dir /Users/me/code/Bob's app`,
    `resume --add-dir /Users/me/code/Bob's-app ${token}`,
    `resume ${token} What's next?`,
    `resume ${token} --add-dir /Users/me/code/review"app`,
  ])("preserves literal quote characters in Codex resume argv: %s", async args => {
    const list = () => rows().map(r => r.pid === 13 ? { ...r, command: `/opt/native/codex ${args}` } : r);
    expect((await check(list))?.process.pid).toBe(13);
    expect(await check(list, { expectedToken: "different" })).toBeNull();
  });
  it("observes a fresh Codex launch into an apostrophe path", async () => {
    const list = () => rows().map(r => r.pid === 13
      ? { ...r, command: "/opt/native/codex -C /Users/me/code/Bob's-app" } : r);
    expect((await check(list, { requireResume: false }))?.process.pid).toBe(13);
    expect(await check(list)).toBeNull();
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
  // #1080 maintainer review of 6e36b94d: a recorded rotation proves only with no Claude, of any
  // runtime shape, beneath the launched process in its foreground.
  it("refuses a recorded rotation with any shape of Claude beneath it in the foreground", () => {
    const rotated = "00000000-0000-4000-8000-000000001077";
    const startedAt = "Thu Oct  1 05:53:16 2026";
    const rotation = { token, process: { pid: 10, startedAt } };
    const top = { pid: 10, ppid: 1, pgid: 10, tpgid: 10, executableName: "claude", command: `claude --resume ${token}`, startedAt };
    const find = (child?: NativeProcessRow) => findExactNativeResumeProcess(child ? [top, child] : [top], 10, "claude-code", rotated, rotation)?.pid ?? null;
    expect(find()).toBe(10);
    const beneath = { pid: 11, ppid: 10, pgid: 10 };
    for (const child of [
      { ...beneath, executableName: "node", command: "node /usr/local/bin/claude --resume other" },
      { ...beneath, executableName: "node", command: "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js -p hi" },
      { ...beneath, executableName: "node", command: "node --no-warnings /usr/local/bin/claude --resume other" },
      { ...beneath, executableName: "node", command: "node -r ./preload.cjs --max-old-space-size=4096 -- /usr/local/bin/claude --resume other" },
      // Node's options are not parsed, so a value option the guard does not know cannot hide Claude
      // (maintainer, against 8208c721), and a claude path given to -r or after -e refuses too.
      { ...beneath, executableName: "node", command: "node --max-old-space-size 8192 /usr/local/bin/claude --session-id other" },
      { ...beneath, executableName: "node", command: "node --diagnostic-dir /tmp/d /usr/local/bin/claude --session-id other" },
      { ...beneath, executableName: "node", command: "node --stack-size 4000 /usr/lib/node_modules/@anthropic-ai/claude-code/cli.mjs" },
      { ...beneath, executableName: "node", command: "node -r /usr/local/bin/claude relay.cjs" },
      { ...beneath, executableName: "node", command: "node --no-warnings -e 1 /usr/local/bin/claude" },
      { ...beneath, command: "claude --resume other" },
      { pid: 11, ppid: 10, command: "/opt/claude.exe --resume other" },
    ]) expect(find(child), child.command).toBeNull();
    // Not Claude, or not in the foreground: the launched process still proves.
    expect(find({ ...beneath, executableName: "node", command: "node relay.cjs" })).toBe(10);
    expect(find({ ...beneath, executableName: "node", command: "node -e 'require(\"/usr/local/bin/claude\")'" })).toBe(10);
    expect(find({ pid: 11, ppid: 10, pgid: 11, executableName: "claude", command: "claude mcp serve" })).toBe(10);
  });

  // A foreground group of -1 or 0 (no controlling terminal) is unknown, not a group no child is in.
  it("refuses a recorded rotation over a Claude child when the launched process's foreground group reads -1 or 0", () => {
    const rotated = "00000000-0000-4000-8000-000000001077";
    const startedAt = "Thu Oct  1 05:53:16 2026";
    const rotation = { token, process: { pid: 10, startedAt } };
    const child = { pid: 11, ppid: 10, pgid: 11, tpgid: 11, executableName: "claude", command: "claude --resume other", startedAt };
    for (const tpgid of [-1, 0]) {
      const top = { pid: 10, ppid: 1, pgid: 10, tpgid, executableName: "claude", command: `claude --resume ${token}`, startedAt };
      expect(findExactNativeResumeProcess([top, child], 10, "claude-code", rotated, rotation)?.pid ?? null, String(tpgid)).toBeNull();
      expect(findExactNativeResumeProcess([top], 10, "claude-code", rotated, rotation)?.pid ?? null, String(tpgid)).toBe(10);
    }
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
    `--settings="/fixture/settings with spaces.json" --session-id ${token}`,
    `--settings {"label":"two words"} --resume ${token}`,
    `--settings={"label":"two words"} --session-id=${token}`,
    `--settings /fixture/settings.json --session-id ${token}`,
    `--settings /fixture/review's-settings.json --session-id ${token}`,
    `--settings /fixture/review"settings.json --session-id ${token}`,
  ])("accepts inline and file settings: %s", async args => {
    expect((await verifyClaudePaneProcess(input(args)))?.process.pid).toBe(21);
    expect((await observeClaudeDelivery(input(args))).state).toBe("verified");
    expect(await verifyClaudePaneProcess({ ...input(args), expectedToken: "different" })).toBeNull();
  });
  it.each([
    `--remote-control orch.lead@rig --session-id ${token}`,
    `--session-id ${token} --remote-control orch.lead@rig`,
    `--remote-control=orch.lead@rig --resume ${token}`,
  ])("proves the exact Claude identity with the launch-only Remote Control option: %s", async args => {
    const actual = input(args);
    expect((await verifyClaudePaneProcess(actual))?.process.pid).toBe(21);
    expect((await observeClaudeDelivery(actual)).state).toBe("verified");
    expect(await verifyClaudePaneProcess({ ...actual, expectedToken: "different" })).toBeNull();
    expect((await observeClaudeDelivery({ ...actual, expectedToken: "different" })).state).toBe("unknown");
  });
  it("preserves an apostrophe in the native Claude executable path", async () => {
    const actual = input(`--settings ${settings[0]![1]} --session-id ${token}`);
    const list = (await actual.listProcesses()).map(r => r.pid === 21 ? { ...r,
      executableName: "2.1.1", command: r.command.replace(/^claude/, "/home/o'neil/.local/share/claude/versions/2.1.1"),
    } : r);
    const native = { ...actual, listProcesses: async () => list };
    expect((await verifyClaudePaneProcess(native))?.process.pid).toBe(21);
    expect((await observeClaudeDelivery(native)).state).toBe("verified");
    expect(await verifyClaudePaneProcess({ ...native, expectedToken: "different" })).toBeNull();
  });
  it.each([
    `--settings ${JSON.stringify({ label: `two words --session-id ${token}` })}`,
    `--settings {"env":{"note":"text --session-id ${token} --model trailing`,
    `--settings ${settings[0]![1]} --session-id ${token} --session-id different`,
    `--settings ${settings[1]![1]} --session-id ${token} --unknown`,
  ])("does not promote ambiguous argv: %s", async args => {
    expect(await verifyClaudePaneProcess(input(args))).toBeNull();
    expect((await observeClaudeDelivery(input(args))).state).not.toBe("verified");
  });
  it.each(["before", "after"])("a literal quote %s settings never promotes settings text into identity", async order => {
    const settings = `--settings ${JSON.stringify({ env: { REVIEW_NOTE: `text --session-id ${token} --model trailing` } })}`;
    const name = '--name review"desk';
    const args = order === "before" ? `${name} ${settings}` : `${settings} ${name}`;
    expect(await verifyClaudePaneProcess(input(args))).toBeNull();
    expect((await observeClaudeDelivery(input(args))).state).toBe("unknown");
    const actualIdentity = input(`${args} --session-id ${token}`);
    expect((await verifyClaudePaneProcess(actualIdentity))?.process.pid).toBe(21);
    expect((await observeClaudeDelivery(actualIdentity)).state).toBe("verified");
    expect(await verifyClaudePaneProcess({ ...actualIdentity, expectedToken: "different" })).toBeNull();
  });
});

describe("observeClaudeDelivery's idle-shell policy: delivery versus launch", () => {
  const startedAt = "Fri Oct 9 07:00:00 2026";
  const shell: NativeProcessRow = { pid: 10, ppid: 1, pgid: 10, tpgid: 10, command: "/bin/bash", executableName: "bash", startedAt };
  // A foreground wrapper starting between the two samples: its own group now owns the terminal.
  const starting: NativeProcessRow[] = [{ ...shell, tpgid: 12 }, { pid: 12, ppid: 10, pgid: 12, tpgid: 12, command: "bash ./start-agent.sh", executableName: "bash", startedAt }];
  const input = (...samples: NativeProcessRow[][]) => {
    let call = 0;
    return { target: "%1", tmux: { getPanePid: async () => 10 }, listProcesses: async () => samples[Math.min(call++, samples.length - 1)]! };
  };

  it("delivery keeps a positive idle shell when the other sample is unknown", async () => {
    expect((await observeClaudeDelivery(input([shell], starting))).state).toBe("idle_shell");
  });

  it("launch needs both samples idle with the same fingerprint, so a starting foreground reads unknown", async () => {
    expect((await observeClaudeDelivery(input([shell], starting), { unknownKeepsIdle: false })).state).toBe("unknown");
    expect((await observeClaudeDelivery(input(starting, [shell]), { unknownKeepsIdle: false })).state).toBe("unknown");
    expect((await observeClaudeDelivery(input([shell], [shell]), { unknownKeepsIdle: false })).state).toBe("idle_shell");
  });
});

// #1079: a `codex` launcher that spawns (not execs) Codex, which spawns its native
// child, as in the report: pane -> sh -> codex (launcher) -> codex -> codex (native).
describe("Codex behind a spawning launcher", () => {
  const launcherRows = (launcher = "", middle = "", native = ""): NativeProcessRow[] => [
    { pid: 10, ppid: 1, pgid: 10, tpgid: 11, executableName: "zsh", command: "-zsh", startedAt },
    { pid: 11, ppid: 10, pgid: 11, tpgid: 11, executableName: "sh", command: "sh /tmp/openrig-tmux-send.txt", startedAt },
    { pid: 12, ppid: 11, pgid: 11, tpgid: 11, executableName: "codex", command: `codex ${launcher}--no-daemon -s workspace-write -c check_for_update_on_startup=false`, startedAt },
    { pid: 13, ppid: 12, pgid: 11, tpgid: 11, executableName: "codex", command: `codex ${middle}--no-daemon -s workspace-write`, startedAt },
    { pid: 14, ppid: 13, pgid: 11, tpgid: 11, executableName: "codex", command: `codex ${native}-c model_provider=local`, startedAt },
  ];
  const resume = `resume ${token} `;

  it("resolves the reporter's fresh three-level chain to the deepest Codex", async () => {
    expect((await check(() => launcherRows(), { requireResume: false }))?.process.pid).toBe(14);
    expect((await check(() => launcherRows(), { requireResume: false, expectedToken: null }))?.process.pid).toBe(14);
  });
  it("delivers to a child that names no identity under a launcher's resume, but never proves it", async () => {
    expect((await check(() => launcherRows(resume), { requireResume: false }))?.process.pid).toBe(14);
    expect(await check(() => launcherRows(resume))).toBeNull();
    expect(await check(() => launcherRows(resume, resume))).toBeNull();
    expect(findExactNativeResumeProcess(launcherRows(resume), 10, "codex", token)).toBeNull();
    expect(await check(() => launcherRows(resume), { requireResume: false, expectedToken: "different" })).toBeNull();
    expect(await check(() => launcherRows(resume), { requireResume: false, expectedToken: null })).toBeNull();
  });
  it("proves a chain whose deepest Codex names the expected conversation", async () => {
    expect((await check(() => launcherRows(resume, resume, resume)))?.process.pid).toBe(14);
    expect((await check(() => launcherRows("", "", resume)))?.process.pid).toBe(14);
    expect(findExactNativeResumeProcess(launcherRows(resume, resume, resume), 10, "codex", token)?.pid).toBe(14);
  });
  it("keeps exact resume strict across the chain", async () => {
    expect(await check(() => launcherRows())).toBeNull();
    expect(await check(() => launcherRows(resume, "resume other "))).toBeNull();
    expect(await check(() => launcherRows(resume, "", "resume --last "))).toBeNull();
    // A deeper `resume --last` is read before the launcher's token, whatever the ps row order.
    const deeperLast = () => launcherRows(resume).map(r => r.pid === 13 ? { ...r, command: "codex resume --last" } : r);
    expect(await check(deeperLast)).toBeNull();
    expect(await check(() => deeperLast().reverse())).toBeNull();
  });
  it("still refuses Codex processes on different branches", async () => {
    const siblings = (r: NativeProcessRow[]) => [...r, { ...r[4]!, pid: 15 }];
    expect(await check(() => siblings(launcherRows()), { requireResume: false })).toBeNull();
    const twoNatives = launcherRows().filter(r => r.pid !== 14).concat({ ...launcherRows()[3]!, pid: 15, ppid: 12 });
    expect(await check(() => twoNatives, { requireResume: false })).toBeNull();
  });
  it("still refuses a non-Codex foreground", async () => {
    expect(await check(() => launcherRows().map(r => r.pid >= 12 ? { ...r, executableName: "node" } : r), { requireResume: false })).toBeNull();
  });
  it("refuses when a launcher link changes between observations", async () => {
    const changed = launcherRows().map(r => r.pid === 12 ? { ...r, startedAt: "Sat Jan  1 12:00:01 2000" } : r);
    expect(await check(vi.fn().mockResolvedValueOnce(launcherRows()).mockResolvedValueOnce(changed), { requireResume: false })).toBeNull();
  });
});

// #1091: Claude's strict finder rejects a shallower token only when a deeper, verified Claude
// runtime in the same chain positively names another conversation (Root's option (b)).
describe("Claude exact-resume finder behind a spawning launcher", () => {
  const other = "00000000-0000-7000-8000-00000000000f";
  const find = (rows: NativeProcessRow[]) => findExactNativeResumeProcess(rows, 10, "claude-code", token)?.pid ?? null;
  // A verified Claude binary (argv0 and OS name claude) on the token, over one child.
  const realRows = (child: string, childName = "claude"): NativeProcessRow[] => [
    { pid: 10, ppid: 1, pgid: 10, tpgid: 11, executableName: "zsh", command: "-zsh", startedAt },
    { pid: 11, ppid: 10, pgid: 11, tpgid: 11, executableName: "claude", command: `claude --resume ${token} --name dev@rig`, startedAt },
    { pid: 12, ppid: 11, pgid: 11, tpgid: 11, executableName: childName, command: child, startedAt },
  ];
  // A script launcher: ps shows the interpreter as argv0, so it is not a verified Claude runtime.
  const scriptRows = (child: string) => realRows(child).map(r => r.pid === 11
    ? { ...r, command: `/bin/sh /shim/claude --resume ${token} --name dev@rig` } : r);
  // #563/#567 company-launcher model: three claude processes; the real Claude names no token.
  const companyRows = (): NativeProcessRow[] => [
    { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "-bash", startedAt },
    { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "sh", command: "/bin/sh /fixture/launch", startedAt },
    { pid: 102, ppid: 101, pgid: 101, tpgid: 101, executableName: "claude", command: `/opt/claude --permission-mode auto --session-id ${token} --name test-c@native-test`, startedAt },
    { pid: 104, ppid: 102, pgid: 101, tpgid: 101, executableName: "claude", command: `/shim/bin/claude --permission-mode auto --session-id ${token} --name test-c@native-test`, startedAt },
    { pid: 105, ppid: 104, pgid: 101, tpgid: 101, executableName: "claude", command: "/shim/claude --settings /shim/settings.json --permission-mode auto", startedAt },
  ];

  it("keeps main's proof for the company-launcher model (opaque real Claude)", () => {
    // Proved as on main; the evidence names 104, the deepest link that names the token.
    expect(findExactNativeResumeProcess(companyRows(), 100, "claude-code", token)?.pid).toBe(104);
  });
  it.each([
    ["ripgrep with a claude pattern", "rg", "rg -n claude src"],
    ["ugrep with a token-like argument", "ugrep", `ugrep -n claude --session-id ${other} file.ts`],
    ["claude mcp serve", "claude", "claude mcp serve"],
  ])("a helper child (%s) neither suppresses nor becomes the proof", (_name, comm, command) => {
    expect(find(realRows(command, comm))).toBe(11);
  });
  it("refuses a script launcher's token over a verified child on another conversation", () => {
    expect(find(scriptRows(`claude --session-id ${other}`))).toBeNull();
  });
  it("keeps main's proof for an opaque child under a script launcher", () => {
    expect(find(scriptRows("claude --settings /shim/settings.json"))).toBe(11);
  });
  it("attributes proof to a child that names the token", () => {
    expect(find(realRows(`claude --session-id ${token}`))).toBe(12);
    expect(find(scriptRows(`claude --resume ${token}`))).toBe(12);
  });
  // Limit: ps cannot tell a launcher binary over the real Claude on Y from a real Claude on X
  // that started a child Claude on Y, so a verified Claude on the token keeps main's proof.
  it("keeps a verified Claude's proof when it starts a child Claude on another conversation", () => {
    expect(find(realRows(`claude --session-id ${other}`))).toBe(11);
  });
  it("keeps main's result without process groups, through a shell, or in another group", () => {
    expect(find(scriptRows(`claude --session-id ${other}`).map(({ pid, ppid, command, executableName }) => ({ pid, ppid, command, executableName })))).toBe(11);
    const viaShell = scriptRows(`claude --session-id ${other}`).flatMap(r => r.pid === 12
      ? [{ ...r, pid: 13, executableName: "bash", command: `/bin/bash -c claude --session-id ${other}` }, { ...r, ppid: 13 }] : [r]);
    expect(find(viaShell)).toBe(11);
    expect(find(scriptRows(`claude --session-id ${other}`).map(r => r.pid === 12 ? { ...r, pgid: 99 } : r))).toBe(11);
  });
  // #1091 round 3.
  it("does not count a grandchild of an intermediate Claude runtime against the launcher", () => {
    const rows = scriptRows("claude --settings /shim/settings.json");
    rows.push({ ...rows[2]!, pid: 13, ppid: 12, command: `claude --session-id ${other}` });
    expect(find(rows)).toBe(11);
  });
  const helper = (pid: number, args: string): NativeProcessRow =>
    ({ pid, ppid: 11, pgid: 11, tpgid: 11, executableName: "ugrep", command: `ugrep -n claude ${args} file.ts`, startedAt });
  it("returns the exact Claude child, never a helper, whatever the row order", () => {
    const base = scriptRows(`claude --resume ${token}`);
    const withHelper = [...base.slice(0, 2), helper(9, `--session-id ${token}`), base[2]!];
    expect(find(withHelper)).toBe(12);
    expect(find([...withHelper].reverse())).toBe(12);
    expect(find([...base, helper(13, `--session-id ${token}`)])).toBe(12);
  });
  it("refuses a script on X with a helper on X over a real Claude on Y", () => {
    const rows = [...scriptRows(`claude --session-id ${other}`), helper(9, `--session-id ${token}`)];
    expect(find(rows)).toBeNull();
    expect(find([...rows].reverse())).toBeNull();
  });
  it("keeps the pane root as the proof when the root Claude has an exact child", () => {
    const rows = realRows(`claude --session-id ${token}`);
    expect(findExactNativeResumeProcess(rows, 11, "claude-code", token)?.pid).toBe(11);
  });
  // #1091 round 4: parents main already accepts as Claude keep main's result.
  it("keeps main's proof for a Node-run Claude or an older Claude row over a child on another conversation", () => {
    const nodeRun = realRows(`claude --session-id ${other}`).map(r => r.pid === 11
      ? { ...r, executableName: "node", command: `node /usr/local/bin/claude --resume ${token}` } : r);
    expect(find(nodeRun)).toBe(11);
    const older = realRows(`claude --session-id ${other}`).map(r => r.pid === 11
      ? { pid: r.pid, ppid: r.ppid, pgid: r.pgid, tpgid: r.tpgid, command: r.command, startedAt } : r);
    expect(find(older)).toBe(11);
    expect(find(scriptRows(`claude --session-id ${other}`))).toBeNull();
    // A Node-shaped argv whose OS executable is a shell is not Node-hosted Claude.
    expect(find(nodeRun.map(r => r.pid === 11 ? { ...r, executableName: "bash" } : r))).toBeNull();
  });
  it.each([
    ["ugrep", `ugrep -n claude --session-id ${token} file.ts`],
    ["rg", `rg claude --resume ${token}`],
  ])("never treats a token-shaped helper (%s) as a runtime parent", (comm, command) => {
    const rows = realRows(`claude --session-id ${other}`).map(r => r.pid === 11 ? { ...r, executableName: comm, command } : r);
    expect(find(rows)).toBeNull();
  });
  it("leaves --fork-session children as on main (separate follow-up)", () => {
    expect(find(scriptRows(`claude --resume ${token} --fork-session`))).toBe(11);
  });
});
