import { describe, expect, it } from "vitest";
import { parseWindowsProcesses, verifyCodexPaneProcess, verifyClaudePaneProcess, observeClaudeDelivery, listNativeProcesses, type NativeProcessRow } from "../src/domain/native-process-lineage.js";

const born = "2026-10-08T01:00:00Z";
function rows(): NativeProcessRow[] {
  return parseWindowsProcesses(JSON.stringify([
    { ProcessId: 100, ParentProcessId: 1, Name: "pwsh.exe", ExecutablePath: "C:\\pwsh.exe", CommandLine: '"C:\\pwsh.exe"', StartedAt: born },
    { ProcessId: 101, ParentProcessId: 100, Name: "codex.exe", ExecutablePath: "C:\\program space\\codex.exe", CommandLine: '"C:\\program space\\codex.exe" resume exact-id', StartedAt: "2026-10-08T01:00:01Z" },
  ]));
}
const verify = (values: NativeProcessRow[], token = "exact-id", foreground = "codex") => verifyCodexPaneProcess({ target: "pane", tmux: { getPanePid: async () => 100, getPaneCommand: async () => foreground }, listProcesses: () => values, expectedToken: token, requireResume: true });
describe("Windows process ancestry without fabricated foreground groups", () => {
  it("keeps the current-main Codex launcher-chain proof with Windows quoting", async () => {
    const values = rows();
    values[1]!.command = '"C:\\program space\\codex.exe" resume "exact-id"';
    values.push({ ...values[1]!, pid: 102, ppid: 101, startedAt: "2026-10-08T01:00:02Z" });
    expect((await verify(values))?.process.pid).toBe(102);
    values[2]!.command = '"C:\\program space\\codex.exe" resume "other-id"';
    expect(await verify(values)).toBeNull();
  });
  it("keeps a Claude rotation bound to the same Windows process birth time", async () => {
    const values = rows();
    Object.assign(values[1]!, { executableName: "claude.exe", executablePath: "C:\\program space\\claude.exe", command: '"C:\\program space\\claude.exe" --resume "exact-id"' });
    const input = { target: "pane", tmux: { getPanePid: async () => 100, getPaneCommand: async () => "claude" }, listProcesses: () => values, expectedToken: "rotated-id",
      rotation: { token: "exact-id", process: { pid: 101, startedAt: values[1]!.startedAt! } } };
    expect((await verifyClaudePaneProcess(input))?.process.pid).toBe(101);
    expect(await verifyClaudePaneProcess({ ...input, rotation: { ...input.rotation, process: { pid: 101, startedAt: born } } })).toBeNull();
    expect((await observeClaudeDelivery(input)).state).toBe("verified");
  });
  it("verifies native Claude against the selected executable and exact session identity", async () => {
    const values = rows();
    Object.assign(values[1]!, { executableName: "claude.exe", executablePath: "C:\\program space\\claude.exe", command: '"C:\\program space\\claude.exe" --session-id exact-id' });
    const input = { target: "pane", tmux: { getPanePid: async () => 100, getPaneCommand: async () => "claude" }, listProcesses: () => values, expectedToken: "exact-id", selectedExecutable: "C:\\program space\\claude.exe" };
    expect((await verifyClaudePaneProcess(input))?.process.pid).toBe(101);
    expect(await verifyClaudePaneProcess({ ...input, selectedExecutable: "C:\\other\\claude.exe" })).toBeNull();
    expect(await verifyClaudePaneProcess({ ...input, expectedToken: "wrong" })).toBeNull();
    expect(await verifyClaudePaneProcess({ ...input, tmux: { ...input.tmux, getPaneCommand: async () => "pwsh" } })).toBeNull();
  });
  it("requires the OS executable, unique lineage and exact resume identity", async () => {
    expect((await verify(rows()))?.process.pid).toBe(101);
    expect(await verify(rows(), "wrong-id")).toBeNull();
    expect(await verify(rows(), "exact-id", "pwsh")).toBeNull();
  });
  it.each(["outside", "recycled", "spoof", "ambiguous", "cycle", "duplicate"])("refuses %s identity evidence", async defect => {
    const values = rows();
    if (defect === "outside") values[1]!.ppid = 999;
    if (defect === "recycled") values[0]!.startedAt = "2026-10-08T02:00:00Z";
    if (defect === "spoof") values[1]!.executablePath = "C:\\different.exe";
    if (defect === "ambiguous") values.push({ ...values[1]!, pid: 102 });
    if (defect === "cycle") values[1]!.ppid = 101;
    if (defect === "duplicate") values.push({ ...values[0]! });
    expect(await verify(values)).toBeNull();
  });
  it("does not promote malformed or unavailable CIM rows", () => {
    expect(parseWindowsProcesses(JSON.stringify([{ ProcessId: 1, ParentProcessId: 0, Name: "codex.exe" }]))).toEqual([]);
  });
  it.skipIf(process.platform !== "win32")("observes this actual Windows Node process using CIM", async () => {
    const current = (await listNativeProcesses()).find(row => row.pid === process.pid);
    expect(current?.platform).toBe("win32");
    expect(current?.executablePath?.toLowerCase()).toBe(process.execPath.toLowerCase());
    expect(current?.pgid).toBeUndefined();
  });
});
