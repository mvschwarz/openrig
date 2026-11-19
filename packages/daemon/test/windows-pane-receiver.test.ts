import { expect, it } from "vitest";
import { verifyWindowsPaneReceiver } from "../src/domain/windows-pane-receiver.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";

it.each(["ready", "idle", "unknown-console", "unlisted-receiver", "unrelated", "two-receivers", "reused-parent", "changing", "bad-executable", "missing-birth"])("native community receiver observation: %s", async kind => {
  const shell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const rows: NativeProcessRow[] = [
    { platform: "win32", pid: 10, ppid: 1, executableName: "powershell.exe", executablePath: shell, command: `"${shell}" -NoProfile`, startedAt: "2026-10-30T00:00:00Z" },
    { platform: "win32", pid: 11, ppid: 10, executableName: "node.exe", executablePath: "C:\\node.exe", command: '"C:\\node.exe" owned.cjs', startedAt: "2026-10-30T00:00:01Z" },
  ];
  let members = [10, 11];
  if (kind === "idle") members = [10];
  if (kind === "unlisted-receiver") members.push(99);
  if (kind === "unrelated") rows[1]!.ppid = 99;
  if (kind === "two-receivers") { rows.push({ ...rows[1]!, pid: 12 }); members.push(12); }
  if (kind === "reused-parent") rows[0]!.startedAt = "2026-10-30T00:00:02Z";
  if (kind === "bad-executable") rows[1]!.command = "C:\\other.exe";
  if (kind === "missing-birth") rows[1]!.startedAt = undefined;
  let calls = 0;
  expect(await verifyWindowsPaneReceiver({ target: "owned", getPanePid: async () => 10,
    listProcesses: () => rows, consoleProcesses: async () => {
      calls++;
      return kind === "unknown-console" ? null : kind === "changing" && calls === 2 ? [10] : members;
    } })).toBe(kind === "ready");
});

it.each(["bash", "sh", "dash", "zsh", "ksh", "fish", "nu", "tcsh", "csh"])("does not count an idle native %s shell as a community receiver", async name => {
  const shell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const child = `C:\\shells\\${name}.exe`;
  const rows: NativeProcessRow[] = [
    { platform: "win32", pid: 10, ppid: 1, executableName: "powershell.exe", executablePath: shell, command: `"${shell}" -NoProfile`, startedAt: "2026-10-30T00:00:00Z" },
    { platform: "win32", pid: 11, ppid: 10, executableName: `${name}.exe`, executablePath: child, command: `"${child}"`, startedAt: "2026-10-30T00:00:01Z" },
  ];
  expect(await verifyWindowsPaneReceiver({ target: "owned", getPanePid: async () => 10,
    listProcesses: () => rows, consoleProcesses: async () => [10, 11] })).toBe(false);
});
