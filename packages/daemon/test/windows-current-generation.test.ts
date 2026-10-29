import { describe, expect, it } from "vitest";
import { paneClaudeSessionIdArgument, resolveLiveCodexThreadId, resolveIdentityVerifiedPiRecord, type ProcessRow } from "../src/domain/model-divergence/current-generation-record.js";
import { windowsArguments } from "../src/adapters/windows-argv.js";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readWindowsProcessesStrict } from "../src/domain/windows-process-table.js";
import { renderWindowsLaunch } from "../src/adapters/windows-launch.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { stopGroup } from "../src/domain/codex-network-default.js";

const id = "12345678-1234-4123-8123-123456789abc";
function row(pid: number, ppid: number, executablePath: string, args: string[] = []): ProcessRow {
  return { platform: "win32", pid, ppid, executablePath, command: windowsArguments([executablePath, ...args]), startedAt: "2026-10-29T00:00:01Z" };
}
const shell = row(100, 1, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoExit"]);
const deps = (rows: ProcessRow[]) => ({ getPanePid: async () => 100, listProcesses: async () => rows, readThreadIdByPid: async (pid: number) => pid === 101 ? id : undefined });

describe("native current occupant process arguments", () => {
  it.skipIf(process.platform !== "win32")("joins an actual PowerShell/Node process pair observed through CIM", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-current-native-"));
    const entry = path.join(root, "runner with space.cjs"), ready = path.join(root, "ready");
    await writeFile(entry, `require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`);
    const argv = [process.execPath, entry, "--session-name", "seat@rig", "--state-root", root, "--cwd", root, "--launch-id", "native-launch"];
    const child = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", renderWindowsLaunch(argv.map(shellQuote).join(" "))], { windowsHide: true, stdio: "ignore" });
    try {
      await expect.poll(async () => { try { return await readFile(ready, "utf8"); } catch { return null; } }, { timeout: 5000 }).toBe("ready");
      const rows = await readWindowsProcessesStrict();
      expect(await resolveIdentityVerifiedPiRecord({ sessionName: "seat@rig", generation: "generation", occupantBootAt: "2026-10-29T00:00:00Z",
        binding: { tmuxSession: "seat@rig", tmuxPane: "%1" }, runner: {
          state: { ready: true, launchId: "native-launch", sessionFile: path.join(root, "sessions", "current.jsonl") }, sessionsDir: path.join(root, "sessions"), entryPath: entry, stateRoot: root,
        } }, { getPanePid: async () => child.pid!, listProcesses: async () => rows }, value => value)).toMatchObject({ ok: true, launchId: "native-launch" });
    } finally {
      await stopGroup(child, 100);
      await expect.poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 3000 }).toBe(true);
      expect(path.dirname(root)).toBe(os.tmpdir());
      await rm(root, { recursive: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 15000);
  it("reads native Claude and Codex executable candidates with quoted paths", async () => {
    const claude = row(101, 100, "C:\\Program Files\\Claude\\claude.exe", ["--session-id", id]);
    expect(await paneClaudeSessionIdArgument("seat", deps([shell, claude]))).toEqual({ ok: true, id });
    const codex = row(101, 100, "C:\\Program Files\\Codex\\codex.exe", ["resume", id]);
    expect(await resolveLiveCodexThreadId("seat", deps([shell, codex]))).toEqual({ ok: true, id });
  });
  it("does not promote a prompt, duplicate selection, unrelated executable or stale OS path", async () => {
    for (const args of [["--", "--resume", id], ["--resume", id, "--session-id", id], ["--session-id", id, "--resume"], ["--resume", id + "suffix"], ["--settings", `--resume ${id}`]]) {
      expect((await paneClaudeSessionIdArgument("seat", deps([shell, row(101, 100, "C:\\Claude\\claude.exe", args)]))).ok).toBe(false);
    }
    const unrelated = row(101, 100, "C:\\other.exe", ["C:\\claude.exe", "--resume", id]);
    const stale = { ...row(101, 100, "C:\\Claude\\claude.exe", ["--resume", id]), executablePath: "C:\\other.exe" };
    for (const candidate of [unrelated, stale]) expect((await paneClaudeSessionIdArgument("seat", deps([shell, candidate]))).ok).toBe(false);
  });
  it("joins a native Pi runner without weakening parent, sidecar or repeated-flag checks", async () => {
    const input = { sessionName: "seat@rig", generation: "generation", occupantBootAt: "2026-10-29T00:00:00Z",
      binding: { tmuxSession: "seat@rig", tmuxPane: "%1" }, runner: {
        state: { ready: true, launchId: "launch", sessionFile: "C:/state/sessions/current.jsonl" }, sessionsDir: "C:/state/sessions",
        entryPath: "C:/program space/runner.js", stateRoot: "C:/state",
      } };
    const args = [input.runner.entryPath, "--session-name", input.sessionName, "--state-root", input.runner.stateRoot, "--cwd", "C:/working space", "--launch-id", "launch"];
    const runner = row(101, 100, "C:\\Program Files\\nodejs\\node.exe", args);
    const select = (rows: ProcessRow[], value = input) => resolveIdentityVerifiedPiRecord(value, deps(rows), path => path);
    expect(await select([shell, runner])).toMatchObject({ ok: true, pid: 101, launchId: "launch" });
    expect((await select([shell, { ...runner, ppid: 102 }, row(102, 100, "C:\\wrapper.exe")])).ok).toBe(false);
    expect((await select([shell, runner, { ...runner, pid: 102 }])).ok).toBe(false);
    expect((await select([shell, row(101, 100, runner.executablePath!, [...args, "--launch-id", "other"])])).ok).toBe(false);
    expect((await select([shell, runner], { ...input, runner: { ...input.runner, state: { ...input.runner.state, launchId: "stale" } } })).ok).toBe(false);
    expect((await select([shell, { ...runner, executablePath: "C:\\other.exe" }])).ok).toBe(false);
  });
});
