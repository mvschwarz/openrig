import { expect, it } from "vitest";
import { windowsScopedLaunch } from "../src/adapters/windows-scoped-launch.js";
import { windowsArguments } from "../src/adapters/windows-argv.js";
import { windowsManagedRunnerParent, windowsCmdBridgeInvocation } from "../src/domain/windows-cmd-bridge.js";
import type { ProcessRow } from "../src/domain/model-divergence/current-generation-record.js";

it.runIf(process.platform === "win32").each([undefined,"OPENRIG_LAUNCH_RECOVERY_0123456789abcdef0123456789abcdef"])("recognizes only the generated scoped parent and its unique later shell (recovery=%s)", recovery => {
  const shell = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const file = "C:\\owned\\openrig-tmux-send-123-12345678-1234-1234-1234-123456789abc.txt";
  const argv = windowsScopedLaunch(shell, "", {}, file, false, recovery).argv;
  const parent = { pid: 100, ppid: 1, platform: "win32", executablePath: shell, command: windowsArguments(argv), startedAt: "2026-11-01T00:00:00Z" } as ProcessRow;
  const child = { pid: 101, ppid: 100, platform: "win32", executablePath: shell, command: windowsArguments([shell]), startedAt: "2026-11-01T00:00:01Z" } as ProcessRow;
  expect(windowsManagedRunnerParent([parent, child], 100)).toBe(101);
  expect(windowsManagedRunnerParent([parent, child, { ...child, pid: 102 }], 100)).toBeNull();
  expect(windowsManagedRunnerParent([parent, { ...child, startedAt: "2026-10-31T23:59:59Z" }], 100)).toBeNull();
  const arbitrary = windowsScopedLaunch(shell, "", {}, "C:\\owned\\arbitrary.txt").argv;
  expect(windowsManagedRunnerParent([{ ...parent, command: windowsArguments(arbitrary) }, child], 100)).not.toBe(101);
  expect(windowsManagedRunnerParent([{ ...parent, command: windowsArguments([...argv, "extra"]) }, child], 100)).not.toBe(101);
  const tampered=[...argv];tampered[4]=Buffer.from(Buffer.from(argv[4]!,"base64").toString("utf16le")+"; Write-Output untrusted","utf16le").toString("base64");
  expect(windowsManagedRunnerParent([{...parent,command:windowsArguments(tampered)},child],100)).not.toBe(101);
  expect(windowsManagedRunnerParent([parent, { ...child, executablePath: "C:\\wrong\\powershell.exe" }], 100)).toBeNull();
});

it.runIf(process.platform === "win32")("accepts exactly one identical MSYS shell fork and rejects changed, deeper or competing children",()=>{
  const exe="C:\\Program Files\\Git\\usr\\bin\\bash.exe", shell=`${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const file="C:\\owned\\openrig-tmux-send-123-12345678-1234-1234-1234-123456789abc.txt";
  const pane={pid:200,ppid:1,platform:"win32",executablePath:exe,command:windowsArguments([exe,"--noprofile","--norc","-i"]),startedAt:"2026-11-01T00:00:00Z"} as ProcessRow;
  const fork={...pane,pid:201,ppid:200,startedAt:"2026-11-01T00:00:01Z"};
  const bridge={pid:202,ppid:201,platform:"win32",executablePath:shell,command:windowsCmdBridgeInvocation(file),startedAt:"2026-11-01T00:00:02Z"} as ProcessRow;
  expect(windowsManagedRunnerParent([pane,fork,bridge],200)).toBe(202);
  expect(windowsManagedRunnerParent([pane,{...fork,command:fork.command+" -c arbitrary"},bridge],200)).toBeNull();
  expect(windowsManagedRunnerParent([pane,fork,bridge,{...fork,pid:203}],200)).toBeNull();
  expect(windowsManagedRunnerParent([pane,fork,{...fork,pid:204,ppid:201,startedAt:"2026-11-01T00:00:02Z"},{...bridge,ppid:204,startedAt:"2026-11-01T00:00:03Z"}],200)).toBeNull();
  expect(windowsManagedRunnerParent([pane,{...fork,startedAt:"2026-10-31T23:59:59Z"},bridge],200)).toBeNull();
});
