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
