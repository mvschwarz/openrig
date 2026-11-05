import { expect, it } from "vitest";
import { observeClaudePaneProcess, verifyClaudePaneProcess, verifyClaudePaneRuntime, type NativeProcessRow } from "../src/domain/native-process-lineage.js";

// A managed launch freezes the realpath of the first `claude` on the daemon's PATH. When that file is a
// `#!` script that execs the real binary (a user's own ~/.local/bin/claude), the live process is the
// binary: ps shows its install path as argv[0] and `claude` as the OS name. The frozen path never
// equals it, so the launch can't be proved unless the process is checked another way (#1477 section 1).
const wrapper = "/home/user/.local/bin/claude";
const binary = "/home/user/.local/share/mise/installs/claude/2.1.302/claude";
const versioned = "/home/user/.local/share/claude/versions/2.1.302";
const startedAt = "Mon Oct 19 09:00:00 2026";
const token = "00000000-0000-4000-8000-000000001477";

function rows(patch: Partial<NativeProcessRow> = {}): NativeProcessRow[] {
  return [
    { pid: 10, ppid: 1, pgid: 10, tpgid: 11, executableName: "bash", command: "-bash", startedAt },
    { pid: 11, ppid: 10, pgid: 11, tpgid: 11, executableName: "sh", command: "/bin/sh fixture-launch.txt", startedAt },
    { pid: 12, ppid: 11, pgid: 11, tpgid: 11, executableName: "claude", executablePath: binary, startedAt,
      command: `${binary} --permission-mode auto --resume ${token} --name seat@rig`, ...patch },
  ];
}
const input = (list: () => NativeProcessRow[], extra: Record<string, unknown> = {}) => ({
  target: "%1", tmux: { getPanePid: async () => 10 }, listProcesses: list, expectedToken: token,
  selectedExecutable: wrapper, scriptLaunch: true, ...extra,
});

it("proves a Claude that a #! wrapper script exec'd, by its OS executable path", async () => {
  expect((await verifyClaudePaneProcess(input(() => rows())))?.process.pid).toBe(12);
  expect((await verifyClaudePaneRuntime(input(() => rows())))?.process.pid).toBe(12);
});

it("accepts the versioned install layout when its OS name is the version and argv[0] is bare", async () => {
  const list = () => rows({ executableName: "2.1.302", executablePath: versioned, command: `claude --resume ${token}` });
  expect((await verifyClaudePaneProcess(input(list)))?.process.pid).toBe(12);
});

it("puts the OS executable path in the fingerprint, so a later check can match it", async () => {
  const first = await observeClaudePaneProcess(input(() => rows()));
  const same = await observeClaudePaneProcess(input(() => rows()));
  const moved = await observeClaudePaneProcess(input(() => rows({ executablePath: "/home/user/other/claude" })));
  expect(first?.fingerprint).toBe(same?.fingerprint);
  expect(moved?.fingerprint).not.toBe(first?.fingerprint);
});

const refused: [string, Partial<NativeProcessRow> | ((r: NativeProcessRow[]) => NativeProcessRow[])][] = [
  ["a missing token", { command: `${binary} --permission-mode auto --name seat@rig` }],
  ["a wrong token", { command: `${binary} --permission-mode auto --resume other --name seat@rig` }],
  ["a Claude outside the foreground group", { pgid: 88 }],
  ["a Claude not under the pane's process", { ppid: 1 }],
  ["a second candidate", r => [...r, { ...r[2]!, pid: 13 }]],
  ["no readable OS path", { executablePath: undefined }],
  ["an OS path not named claude", { executablePath: "/usr/bin/node" }],
  ["an OS path whose name disagrees with the OS process name", { executableName: "node" }],
  ["an OS path and process name that agree on a program that is not Claude", { executableName: "node", executablePath: "/usr/bin/node" }],
  ["a versioned path whose version disagrees with the OS process name", { executableName: "2.1.301", executablePath: versioned }],
  ["a relative OS path", { executablePath: "home/user/claude" }],
  ["an OS path of a replaced binary", { executablePath: `${binary} (deleted)` }],
  ["an argv[0] that is not Claude", { command: `/bin/echo --resume ${token}` }],
];
it.each(refused)("keeps refusing %s", async (_name, patch) => {
  const list = () => typeof patch === "function" ? patch(rows()) : rows(patch);
  expect(await verifyClaudePaneProcess(input(list))).toBeNull();
});

const changes: [string, Partial<NativeProcessRow>][] = [
  ["pid", { pid: 14 }],
  ["start time", { startedAt: "Mon Oct 19 09:00:09 2026" }],
  ["executable path", { executablePath: "/home/user/other/installs/claude/2.1.302/claude" }],
];
it.each(changes)("refuses a process whose %s changes between the two samples", async (_name, patch) => {
  let reads = 0;
  expect(await verifyClaudePaneProcess(input(() => rows(reads++ === 0 ? {} : patch)))).toBeNull();
});

it("keeps today's exact-path rule for a native binary: a path other than the frozen one is refused", async () => {
  expect((await verifyClaudePaneProcess(input(() => rows(), { selectedExecutable: binary, scriptLaunch: false })))?.process.pid).toBe(12);
  expect(await verifyClaudePaneProcess(input(() => rows(), { scriptLaunch: false }))).toBeNull();
  expect(await verifyClaudePaneProcess(input(() => rows(), { scriptLaunch: undefined }))).toBeNull();
});

it("uses the new rule only when the exact-path match finds nothing", async () => {
  // A bare `claude` title matches today; the path-named process beside it does not, and must not make this ambiguous.
  const list = () => [...rows({ executableName: "claude", executablePath: undefined, command: `claude --resume ${token}` }),
    { ...rows()[2]!, pid: 13 }];
  expect((await verifyClaudePaneProcess(input(list)))?.process.pid).toBe(12);
  expect((await verifyClaudePaneProcess(input(list, { scriptLaunch: false })))?.process.pid).toBe(12);
});

it("leaves a bare-title Claude with no OS path as it is today", async () => {
  const list = () => rows({ executablePath: undefined, command: `claude --resume ${token}` });
  const withRule = await observeClaudePaneProcess(input(list));
  const today = await observeClaudePaneProcess(input(list, { scriptLaunch: false }));
  expect(withRule?.process.pid).toBe(12);
  expect(withRule?.fingerprint).toBe(today?.fingerprint);
});

it("leaves a Nix wrapProgram launch (also a #! script) as it is today", async () => {
  const store = "/nix/store/6gsgll38snbxizg97jfykgc206m9nily-claude-code-2.1.280/bin";
  const nix = () => rows({ executableName: ".claude-unwrapp", executablePath: `${store}/.claude-unwrapped`, command: `claude --resume ${token}` });
  const nixInput = (extra: Record<string, unknown>) => input(nix, { selectedExecutable: `${store}/claude`, ...extra });
  const withRule = await observeClaudePaneProcess(nixInput({}));
  const today = await observeClaudePaneProcess(nixInput({ scriptLaunch: false }));
  expect(withRule?.process.pid).toBe(12);
  expect(withRule?.fingerprint).toBe(today?.fingerprint);
  // And a different launch's wrapper still does not prove it.
  expect(await verifyClaudePaneProcess(nixInput({ selectedExecutable: "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-claude-code-2.1.281/bin/claude" }))).toBeNull();
});

// #2341: a wrapper that starts Claude WITHOUT exec stays the pane's foreground group leader, running the frozen script
// (`/bin/sh <wrapper> …`), and Claude is its child under any name (here a versioned binary outside the native layout).
const elf = "/opt/claude-runtime/2.1.316";
const launched = `--permission-mode auto --session-id ${token} --name seat@rig`;
function nonExec(patch: Partial<NativeProcessRow> = {}, wrapperCommand = `/bin/sh ${wrapper} ${launched}`): NativeProcessRow[] {
  return [
    { pid: 20, ppid: 1, pgid: 20, tpgid: 21, executableName: "bash", command: "/bin/bash", startedAt },
    { pid: 21, ppid: 20, pgid: 21, tpgid: 21, executableName: "claude", command: wrapperCommand, startedAt },
    { pid: 22, ppid: 21, pgid: 21, tpgid: 21, executableName: "2.1.316", command: `${elf} ${launched}`, startedAt, ...patch },
  ];
}
const nonExecInput = (list: () => NativeProcessRow[], extra: Record<string, unknown> = {}) =>
  input(list, { tmux: { getPanePid: async () => 20 }, ...extra });

it("proves the Claude that a non-exec #! wrapper started, as the direct child of the process running the frozen script", async () => {
  expect((await verifyClaudePaneProcess(nonExecInput(() => nonExec())))?.process.pid).toBe(22);
  expect((await verifyClaudePaneRuntime(nonExecInput(() => nonExec())))?.process.pid).toBe(22);
});

it("accepts the script after one shebang option (`#!/bin/bash -e`)", async () => {
  const list = () => nonExec({}, `/bin/bash -e ${wrapper} ${launched}`);
  expect((await verifyClaudePaneProcess(nonExecInput(list)))?.process.pid).toBe(22);
});

const nonExecRefused: [string, () => NativeProcessRow[], Record<string, unknown>?][] = [
  ["a child naming another conversation", () => nonExec({ command: `${elf} --session-id 00000000-0000-4000-8000-000000000002` })],
  ["a child naming no conversation", () => nonExec({ command: `${elf} --print hello` })],
  ["a parent running another script", () => nonExec({}, `/bin/sh /home/user/.local/bin/other ${launched}`)],
  ["a script path that is only an argument", () => nonExec({}, `/bin/sh -c 'exec x' ${wrapper} ${launched}`)],
  ["a child outside the foreground group", () => nonExec({ pgid: 88 })],
  ["a grandchild of the script", () => [...nonExec({ executableName: "sh", command: "/bin/sh -c run-claude" }), { ...nonExec()[2]!, pid: 23, ppid: 22 }]],
  ["two children naming the conversation", () => [...nonExec(), { ...nonExec()[2]!, pid: 23 }]],
  ["a launch that wasn't a script", () => nonExec(), { scriptLaunch: false }],
  ["another launch's wrapper", () => nonExec(), { selectedExecutable: "/home/user/.local/bin/claude-other" }],
];
it.each(nonExecRefused)("still refuses %s", async (_name, list, extra = {}) => {
  expect(await verifyClaudePaneProcess(nonExecInput(list, extra))).toBeNull();
});

it("refuses a non-exec child whose process changes between the two samples", async () => {
  let reads = 0;
  expect(await verifyClaudePaneProcess(nonExecInput(() => nonExec(reads++ === 0 ? {} : { pid: 24 })))).toBeNull();
});

// #2341, the reported frame: the native installer's `~/.local/bin/claude` is a symlink to `versions/<ver>`, and a managed
// launch freezes its realpath. The live Claude can still spell argv[0] through the link, with the OS name `claude`; the
// OS's own executable path says it runs exactly the frozen file.
const link = "/home/user/.local/bin/claude";
const installed = "/home/user/.local/share/claude/versions/2.1.316";
function throughLink(patch: Partial<NativeProcessRow> = {}): NativeProcessRow[] {
  return [
    { pid: 30, ppid: 1, pgid: 30, tpgid: 32, executableName: "fish", command: "-fish", startedAt },
    { pid: 31, ppid: 30, pgid: 31, tpgid: 32, executableName: "fish", command: "fish", startedAt },
    { pid: 32, ppid: 31, pgid: 32, tpgid: 32, executableName: "claude", executablePath: installed, command: `${link} ${launched}`, startedAt, ...patch },
  ];
}
const linkInput = (list: () => NativeProcessRow[], extra: Record<string, unknown> = {}) =>
  input(list, { tmux: { getPanePid: async () => 30 }, selectedExecutable: installed, scriptLaunch: false, ...extra });

it("proves a Claude spelled through the installer's symlink when the OS says it runs the frozen file", async () => {
  expect((await verifyClaudePaneProcess(linkInput(() => throughLink())))?.process.pid).toBe(32);
  expect((await verifyClaudePaneRuntime(linkInput(() => throughLink())))?.process.pid).toBe(32);
});

const linkRefused: [string, Partial<NativeProcessRow> | ((r: NativeProcessRow[]) => NativeProcessRow[])][] = [
  ["another install's binary", { executablePath: "/home/user/.local/share/claude/versions/2.1.315" }],
  ["no readable OS path", { executablePath: undefined }],
  ["a relative OS path", { executablePath: "home/user/.local/share/claude/versions/2.1.316" }],
  ["an OS path with a dot segment", { executablePath: "/home/user/.local/share/claude/versions/../versions/2.1.316" }],
  ["another conversation", { command: `${link} --permission-mode auto --session-id 00000000-0000-4000-8000-000000000002 --name seat@rig` }],
  ["an argv[0] that isn't Claude", { command: `/usr/bin/node ${launched}` }],
  ["a process outside the foreground group", { pgid: 88 }],
  ["a second candidate", r => [...r, { ...r[2]!, pid: 33 }]],
];
it.each(linkRefused)("still refuses a symlink-spelled process with %s", async (_name, patch) => {
  const list = () => typeof patch === "function" ? patch(throughLink()) : throughLink(patch);
  expect(await verifyClaudePaneProcess(linkInput(list))).toBeNull();
});

it("refuses a symlink-spelled process that changes between the two samples", async () => {
  let reads = 0;
  expect(await verifyClaudePaneProcess(linkInput(() => throughLink(reads++ === 0 ? {} : { pid: 34 })))).toBeNull();
});
