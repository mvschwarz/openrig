import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defaultListProcesses } from "../src/adapters/codex-runtime-adapter.js";
import { readNativeProcessArguments } from "../src/domain/native-process-arguments.js";
import { findExactNativeResumeProcess, verifyCodexPaneProcess } from "../src/domain/native-process-lineage.js";
// The fixture's synthetic PIDs must never inspect host processes.
vi.mock("../src/domain/native-process-arguments.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/domain/native-process-arguments.js")>(),
  readNativeProcessArguments: vi.fn(async () => new Map()),
}));
import { restoreProc, serveProcRoot, writeFakeProc } from "./helpers/fake-proc.js";

let scratch: string | undefined;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  restoreProc();
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
  vi.mocked(readNativeProcessArguments).mockReset();
  vi.mocked(readNativeProcessArguments).mockResolvedValue(new Map());
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

it("reads foreground identity through the real async executable and parser path", async () => {
  // ps is the process table's source off Linux.
  Object.defineProperty(process, "platform", { value: "darwin" });
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-read-"));
  // A hermetic ps executable; no provider, tmux or daemon is launched.
  const output = [
    "PID PPID PGID TPGID UCOMM LSTART COMMAND",
    "101 1 101 102 zsh Sat Jan  1 12:00:00 2000 -zsh",
    "102 101 102 102 node Sat Jan  1 12:00:00 2000 node /opt/bin/codex -C /project",
    "103 102 102 102 codex Sat Jan  1 12:00:00 2000 /opt/vendor/bin/codex -C /project",
    "104 1 104 -1 node Sat Jan  1 12:00:00 2000 node /tmp/other.js --label codex",
    // Linux task names may contain spaces (prctl PR_SET_NAME / process.title).
    "106 1 106 -1 tmux: server    Sat Jan  1 12:00:00 2000 tmux new-session -d",
    "107 1 107 -1 node (vitest 1) Sat Jan  1 12:00:00 2000 node (vitest 1)",
    "broken row",
    "105 1 105 0",
  ];
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(path.join(scratch, "ps"), "#!/bin/sh\n"
    + `printf '%s\\n' "$@" > ${quote(path.join(scratch, "args"))}\n`
    + `printf '%s\\n' ${output.map(quote).join(" ")}\n`, { mode: 0o755 });
  vi.stubEnv("PATH", scratch);
  const rows = await defaultListProcesses();
  expect(fs.readFileSync(path.join(scratch, "args"), "utf8")).toBe("-Ao\npid,ppid,pgid,tpgid,ucomm,lstart,command\n");
  expect(rows).toEqual([
    { pid: 101, ppid: 1, pgid: 101, tpgid: 102, executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000", command: "-zsh" },
    { pid: 102, ppid: 101, pgid: 102, tpgid: 102, executableName: "node", startedAt: "Sat Jan  1 12:00:00 2000", command: "node /opt/bin/codex -C /project" },
    { pid: 103, ppid: 102, pgid: 102, tpgid: 102, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000", command: "/opt/vendor/bin/codex -C /project", argv: null },
    { pid: 104, ppid: 1, pgid: 104, tpgid: -1, executableName: "node", startedAt: "Sat Jan  1 12:00:00 2000", command: "node /tmp/other.js --label codex" },
    { pid: 106, ppid: 1, pgid: 106, tpgid: -1, executableName: "tmux: server", startedAt: "Sat Jan  1 12:00:00 2000", command: "tmux new-session -d" },
    { pid: 107, ppid: 1, pgid: 107, tpgid: -1, executableName: "node (vitest 1)", startedAt: "Sat Jan  1 12:00:00 2000", command: "node (vitest 1)" },
  ]);
  // A rejected helper (including a policy timeout) must leave the table intact.
  vi.mocked(readNativeProcessArguments).mockRejectedValueOnce(new Error("argv helper rejected"))
    .mockRejectedValueOnce(new Error("policy timeout"));
  const observation = await verifyCodexPaneProcess({ target: "%1", tmux: { getPanePid: async () => 101 },
    listProcesses: defaultListProcesses, expectedToken: "recorded", requireResume: false });
  expect(observation?.process.pid).toBe(103);
  expect(observation?.process.argv).toBeNull();
  expect(findExactNativeResumeProcess(await defaultListProcesses(), 101, "codex", "recorded")).toBeNull();
  fs.writeFileSync(path.join(scratch, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  expect(await defaultListProcesses()).toEqual([]);
});

it("reads foreground identity through the real /proc reader and parser path", async () => {
  const started = "Sat Jan  1 12:00:00 2000";
  const listed = [
    { pid: 101, ppid: 1, pgid: 101, tpgid: 102, name: "zsh", startedAt: started, command: "-zsh" },
    { pid: 102, ppid: 101, pgid: 102, tpgid: 102, name: "node", startedAt: started, command: "node /opt/bin/codex -C /project" },
    { pid: 103, ppid: 102, pgid: 102, tpgid: 102, name: "codex", startedAt: started, command: "/opt/vendor/bin/codex -C /project",
      argv: ["/opt/vendor/bin/codex", "-C", "/project"] },
    { pid: 104, ppid: 1, pgid: 104, tpgid: -1, name: "node", startedAt: started, command: "node /tmp/other.js --label codex" },
    // Linux task names may contain spaces (prctl PR_SET_NAME / process.title).
    { pid: 106, ppid: 1, pgid: 106, tpgid: -1, name: "tmux: server", startedAt: started, command: "tmux new-session -d" },
    { pid: 107, ppid: 1, pgid: 107, tpgid: -1, name: "node (vitest 1)", startedAt: started, command: "node (vitest 1)" },
  ];
  const root = writeFakeProc(listed);
  // A pid whose stat is cut short is skipped, as ps's broken rows are.
  fs.mkdirSync(path.join(root, "105"));
  fs.writeFileSync(path.join(root, "105", "stat"), "105 (sh) S 1 105");
  fs.writeFileSync(path.join(root, "105", "cmdline"), "");
  serveProcRoot(root);
  // No ps runs: one that did would fail the read.
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-read-"));
  fs.writeFileSync(path.join(scratch, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  vi.stubEnv("PATH", scratch);
  vi.mocked(readNativeProcessArguments).mockClear();
  const rows = await defaultListProcesses();
  expect(rows.sort((a, b) => a.pid - b.pid)).toEqual(listed.map(({ name, ...row }) => ({ ...row, executableName: name })));
  expect(readNativeProcessArguments).not.toHaveBeenCalled();
  serveProcRoot(path.join(root, "gone"));
  expect(await defaultListProcesses()).toEqual([]);
});

it("keeps the foreground Codex deliverable beyond the argv reader's 128-process budget", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-budget-"));
  const started = "Sat Jan  1 12:00:00 2000";
  const output = [
    "PID PPID PGID TPGID UCOMM LSTART COMMAND",
    `101 1 101 102 zsh ${started} -zsh`,
    ...Array.from({ length: 128 }, (_, index) => `${200 + index} 1 ${200 + index} ${200 + index} codex ${started} codex resume recorded`),
    `400 101 102 102 codex ${started} codex resume recorded`,
    `401 1 401 -1 codex ${started} codex resume recorded`,
  ];
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(path.join(scratch, "ps"), `#!/bin/sh\nprintf '%s\\n' ${output.map(quote).join(" ")}\n`, { mode: 0o755 });
  vi.stubEnv("PATH", scratch);
  vi.mocked(readNativeProcessArguments).mockImplementation(async requested =>
    new Map(requested.slice(0, 128).map(pid => [pid, ["codex", "resume", "recorded"]])));
  const rows = await defaultListProcesses();
  expect(readNativeProcessArguments).toHaveBeenCalledWith([...Array.from({ length: 128 }, (_, index) => 200 + index), 400]);
  expect(rows.find(row => row.pid === 400)?.argv).toBeNull();
  expect((await verifyCodexPaneProcess({ target: "%1", tmux: { getPanePid: async () => 101 },
    listProcesses: defaultListProcesses, expectedToken: "recorded", requireResume: false }))?.process.pid).toBe(400);
  expect(findExactNativeResumeProcess(rows, 101, "codex", "recorded")).toBeNull();
});

it("reads this test process with the installed ps columns, without starting a provider", async () => {
  const rows = await defaultListProcesses();
  const self = rows.find((r) => r.pid === process.pid);
  expect(self).toBeDefined();
  expect(self!.ppid).toBe(process.ppid);
  expect(self!.pgid).toBeGreaterThan(0);
  expect(Number.isInteger(self!.tpgid)).toBe(true);
  expect(self!.executableName).toBeTruthy();
  expect(self!.command).toBeTruthy();
  expect(self!.startedAt).toMatch(/\d{2}:\d{2}:\d{2}.*\d{4}/);
});
