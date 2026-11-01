import { expect, it } from "vitest";
import { windowsScopedLaunch } from "../src/adapters/windows-scoped-launch.js";
import { windowsArguments } from "../src/adapters/windows-argv.js";
import { windowsManagedRunnerParent } from "../src/domain/windows-cmd-bridge.js";
import type { ProcessRow } from "../src/domain/model-divergence/current-generation-record.js";

it.runIf(process.platform === "win32")("recognizes only the generated scoped parent and its unique later shell", () => {
  const shell = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const file = "C:\\owned\\openrig-tmux-send-123-12345678-1234-1234-1234-123456789abc.txt";
  const argv = windowsScopedLaunch(shell, "", {}, file).argv;
  const parent = { pid: 100, ppid: 1, platform: "win32", executablePath: shell, command: windowsArguments(argv), startedAt: "2026-11-01T00:00:00Z" } as ProcessRow;
  const child = { pid: 101, ppid: 100, platform: "win32", executablePath: shell, command: windowsArguments([shell]), startedAt: "2026-11-01T00:00:01Z" } as ProcessRow;
  expect(windowsManagedRunnerParent([parent, child], 100)).toBe(101);
  expect(windowsManagedRunnerParent([parent, child, { ...child, pid: 102 }], 100)).toBeNull();
  expect(windowsManagedRunnerParent([parent, { ...child, startedAt: "2026-10-31T23:59:59Z" }], 100)).toBeNull();
  const arbitrary = windowsScopedLaunch(shell, "", {}, "C:\\owned\\arbitrary.txt").argv;
  expect(windowsManagedRunnerParent([{ ...parent, command: windowsArguments(arbitrary) }, child], 100)).not.toBe(101);
  expect(windowsManagedRunnerParent([{ ...parent, command: windowsArguments([...argv, "extra"]) }, child], 100)).not.toBe(101);
  expect(windowsManagedRunnerParent([parent, { ...child, executablePath: "C:\\wrong\\powershell.exe" }], 100)).toBeNull();
});
