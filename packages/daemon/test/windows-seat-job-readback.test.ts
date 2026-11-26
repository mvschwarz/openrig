import { describe, expect, it, vi } from "vitest";
import { windowsScopedLaunch } from "../src/adapters/windows-scoped-launch.js";
import { readWindowsSeatJobForPane } from "../src/domain/windows-seat-job-readback.js";
import type { WindowsProcessRow } from "../src/domain/windows-process-table.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { powershellQuote } from "../src/adapters/windows-launch.js";

function fixture() {
  const shell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const name = "C:\\temp\\openrig-tmux-send-7-01234567-0123-0123-0123-0123456789ab.txt";
  const guardian = windowsScopedLaunch(shell, "", {}, name);
  const row = (pid: number, ppid: number, command: string, startedAt: string): WindowsProcessRow => ({
    platform: "win32", pid, ppid, executableName: "powershell.exe", executablePath: shell, command, startedAt,
  });
  return [row(10, 1, `"${shell}"`, "2026-01-01T00:00:00.000Z"),
    row(20, 10, guardian.argv.map(s => `"${s}"`).join(" "), "2026-01-01T00:00:01.000Z"),
    row(30, 20, `"${shell}"`, "2026-01-01T00:00:02.000Z")];
}

describe.runIf(process.platform === "win32")("Windows seat Job pane readback", () => {
  it("requires the scoped descendant and a live Job member, then rechecks birth identity", async () => {
    const rows = fixture(), inspect = vi.fn(async (guardian: number, target?: number) => {
      if (guardian !== 20 || target !== 30) throw new Error("not a member");
      return { memoryMax: 268435456, activeProcesses: 1 };
    });
    const census = vi.fn(async () => rows);
    expect(await readWindowsSeatJobForPane(10, { census, inspect })).toEqual({ memoryMax: 268435456, activeProcesses: 1 });
    expect(census).toHaveBeenCalledTimes(2);
  });
  it("does not accept an unrelated guardian, a missing member, or a changed birth identity", async () => {
    const rows = fixture();
    await expect(readWindowsSeatJobForPane(30, { census: async () => rows, inspect: async () => ({ memoryMax: 1, activeProcesses: 1 }) })).rejects.toThrow();
    await expect(readWindowsSeatJobForPane(10, { census: async () => rows, inspect: async () => { throw new Error("not a member"); } })).rejects.toThrow();
    let reads = 0;
    await expect(readWindowsSeatJobForPane(10, { census: async () => ++reads === 1 ? rows : rows.map(r => r.pid === 20 ? { ...r, startedAt: "2027-01-01T00:00:00.000Z" } : r),
      inspect: async () => ({ memoryMax: 1, activeProcesses: 1 }) })).rejects.toThrow(/identity changed/);
  });
});

it.skipIf(process.platform !== "win32")("reads a real scoped guardian and Job member, then refuses after exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openrig-seat-readback-"));
  const marker = join(dir, "marker"), target = join(dir, "target.ps1");
  const file = join(dir, `openrig-tmux-send-${process.pid}-${randomUUID()}.txt`);
  // The readback takes two process censuses plus a PowerShell exchange; a short-lived target can exit
  // between them, so the target is held well past the test's own budget.
  writeFileSync(marker, "pending"); writeFileSync(target, "Start-Sleep -Seconds 25\n");
  const shell = join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const launch = windowsScopedLaunch(`"${shell}" -NoProfile`, `& ${powershellQuote(target)}`,
    { SystemRoot: process.env.SystemRoot, TEMP: dir, TMP: dir }, file, false, undefined, { memoryMax: 268435456, marker });
  writeFileSync(file, launch.content);
  const child = spawn(launch.argv[0]!, launch.argv.slice(1), { cwd: dir, env: process.env, windowsHide: true, stdio: "ignore" });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  try {
    await expect.poll(() => readFileSync(marker, "utf8"), { timeout: 10000 }).toMatch(/^started\|\d+$/);
    const targetPid = Number(readFileSync(marker, "utf8").split("|")[1]);
    expect(await readWindowsSeatJobForPane(child.pid!, { targetPid })).toMatchObject({ memoryMax: 268435456, activeProcesses: 1 });
    expect(await exited).toBe(0);
    await expect(readWindowsSeatJobForPane(child.pid!)).rejects.toThrow();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited.catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
