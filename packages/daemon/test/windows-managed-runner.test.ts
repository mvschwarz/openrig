import { beforeEach, describe, expect, it, vi } from "vitest";
import { windowsArguments } from "../src/adapters/windows-argv.js";
import { verifyWindowsManagedRunner, type WindowsRunnerEvidence } from "../src/domain/windows-managed-runner.js";
import { defaultListProcessesStrict } from "../src/domain/resume-metadata-refresher.js";
import { ProcessCensus } from "../src/domain/process-census.js";
import type { ProcessRow } from "../src/domain/model-divergence/current-generation-record.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const table = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../src/domain/process-table.js", () => ({ readProcessTable: table.read }));
const shell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", node = "C:\\Program Files\\nodejs\\node.exe";
function fixture(runtime: "pi" | "omp" | "stub" = "pi") {
  const input: WindowsRunnerEvidence = { runtime, sessionName: "worker@fixture", entryPath: "C:\\openrig space\\runner.js",
    stateRoot: "C:\\state", cwd: "C:\\project space", launchId: "attempt-1", getPanePid: async () => 10 };
  const words = [node, input.entryPath!, "--session-name", input.sessionName,
    ...(runtime === "stub" ? [] : ["--state-root", input.stateRoot!]), "--cwd", input.cwd, "--launch-id", input.launchId!,
    ...(runtime === "omp" ? ["--runtime", "omp"] : [])];
  const rows: ProcessRow[] = [
    { platform: "win32", pid: 10, ppid: 1, executablePath: shell, command: windowsArguments([shell, "-NoProfile"]), startedAt: "2026-10-29T12:00:00Z" },
    { platform: "win32", pid: 11, ppid: 10, executablePath: node, command: windowsArguments(words), startedAt: "2026-10-29T12:00:01Z" },
  ];
  return { input, rows, words };
}
beforeEach(() => { table.read.mockReset(); });

describe("native managed runner witness", () => {
  it.runIf(process.platform === "win32").each(["pi", "omp", "stub"] as const)("joins existing entry/cwd/state aliases for %s while rejecting distinct paths", async runtime => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-witness-alias-"));
    const alias = path.join(root, "alias");
    try {
      const physical = path.join(root, "physical"); fs.mkdirSync(physical);
      for (const name of ["cwd", "state", "other"]) fs.mkdirSync(path.join(physical, name));
      fs.writeFileSync(path.join(physical, "runner.js"), "// owned, not executed");
      fs.writeFileSync(path.join(physical, "other.js"), "// different");
      fs.symlinkSync(physical, alias, "junction");
      const f = fixture(runtime);
      f.input.entryPath = path.join(alias, "runner.js"); f.input.cwd = path.join(alias, "cwd"); f.input.stateRoot = path.join(alias, "state");
      f.words[1] = path.join(physical, "runner.js");
      f.words[f.words.indexOf("--cwd") + 1] = path.join(physical, "cwd");
      if (runtime !== "stub") f.words[f.words.indexOf("--state-root") + 1] = path.join(physical, "state");
      f.rows[1]!.command = windowsArguments(f.words); table.read.mockResolvedValue(f.rows);
      expect(await verifyWindowsManagedRunner(f.input)).toBe(true);
      expect(await verifyWindowsManagedRunner({ ...f.input, entryPath: path.join(physical, "other.js") })).toBe(false);
      expect(await verifyWindowsManagedRunner({ ...f.input, cwd: path.join(physical, "other") })).toBe(false);
      if (runtime !== "stub") expect(await verifyWindowsManagedRunner({ ...f.input, stateRoot: path.join(physical, "other") })).toBe(false);
      expect(await verifyWindowsManagedRunner({ ...f.input, launchId: "other-launch" })).toBe(false);
    } finally { if (fs.existsSync(alias)) fs.unlinkSync(alias); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it.each(["pi", "omp", "stub"] as const)("accepts the exact %s direct runner with native executable identity", async runtime => {
    const f = fixture(runtime); table.read.mockResolvedValue(f.rows);
    expect(await verifyWindowsManagedRunner(f.input)).toBe(true);
  });
  it.each(["gone", "launch", "entry", "cwd", "root", "duplicate-flag", "runtime", "other-executable", "missing-start", "parent-reused", "nested", "competitor", "duplicate-pid", "missing-native-metadata"])("keeps %s evidence unready", async kind => {
    const f = fixture(), runner = f.rows[1]!;
    if (kind === "gone") f.rows.pop();
    if (kind === "launch") f.input.launchId = "older-attempt";
    if (kind === "entry") f.words[1] = "C:\\other\\runner.js";
    if (kind === "cwd") f.input.cwd = "C:\\other";
    if (kind === "root") f.input.stateRoot = "C:\\other";
    if (kind === "duplicate-flag") f.words.push("--launch-id", "attempt-1");
    if (kind === "runtime") f.words.push("--runtime", "omp");
    if (kind === "other-executable") runner.executablePath = shell;
    if (kind === "missing-start") delete runner.startedAt;
    if (kind === "parent-reused") f.rows[0]!.startedAt = "2026-10-29T12:00:02Z";
    if (kind === "nested") { runner.ppid = 12; f.rows.push({ ...f.rows[0]!, pid: 12, ppid: 10 }); }
    if (kind === "competitor") f.rows.push({ ...runner, pid: 12 });
    if (kind === "duplicate-pid") f.rows.push({ ...runner });
    if (kind === "missing-native-metadata") for (const row of f.rows) { delete row.platform; delete row.executablePath; }
    runner.command = windowsArguments(f.words); table.read.mockResolvedValue(f.rows);
    expect(await verifyWindowsManagedRunner(f.input)).toBe(false);
  });
  it("keeps failed census and changed pane unknown", async () => {
    const f = fixture(); table.read.mockRejectedValueOnce(Error("unavailable"));
    expect(await verifyWindowsManagedRunner(f.input)).toBe(false);
    table.read.mockResolvedValue(f.rows);
    f.input.getPanePid = vi.fn().mockResolvedValueOnce(10).mockResolvedValueOnce(20);
    expect(await verifyWindowsManagedRunner(f.input)).toBe(false);
  });
  it("retains Windows identity through the strict shared census and coalesces readers", async () => {
    const f = fixture(); table.read.mockResolvedValue(f.rows);
    const census = new ProcessCensus({ list: defaultListProcessesStrict });
    const results = await Promise.all(Array.from({ length: 8 }, () => verifyWindowsManagedRunner({ ...f.input, listProcesses: () => census.list() })));
    expect(results).toEqual(Array(8).fill(true));
    expect(table.read).toHaveBeenCalledTimes(1);
    expect(await census.list()).toMatchObject(f.rows);
  });
});
