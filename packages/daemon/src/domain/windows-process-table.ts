import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

export interface WindowsProcessRow {
  platform: "win32";
  pid: number;
  ppid: number;
  executableName: string;
  executablePath: string;
  command: string;
  startedAt: string;
}
const exec = promisify(execFile);

/** CIM supplies executable identity and creation time, never POSIX foreground groups. */
export function parseWindowsProcesses(output: string): WindowsProcessRow[] {
  const rows: unknown = JSON.parse(output.replace(/^\uFEFF/, ""));
  if (!Array.isArray(rows)) throw new Error("Windows process census was not an array");
  return rows.flatMap((value): WindowsProcessRow[] => {
    const row = value as Record<string, unknown>;
    if (!row || !Number.isSafeInteger(row.ProcessId) || Number(row.ProcessId) <= 0
      || !Number.isSafeInteger(row.ParentProcessId) || Number(row.ParentProcessId) < 0
      || typeof row.Name !== "string" || typeof row.ExecutablePath !== "string"
      || typeof row.CommandLine !== "string" || typeof row.StartedAt !== "string"
      || !Number.isFinite(Date.parse(row.StartedAt))) return [];
    return [{ platform: "win32", pid: Number(row.ProcessId), ppid: Number(row.ParentProcessId),
      executableName: row.Name, executablePath: row.ExecutablePath, command: row.CommandLine, startedAt: row.StartedAt }];
  });
}

/** Reject a failed query rather than caching a successful empty census. */
export async function readWindowsProcessesStrict(): Promise<WindowsProcessRow[]> {
  const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,@{n='StartedAt';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}}}) | ConvertTo-Json -Compress";
  const { stdout } = await exec(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  return parseWindowsProcesses(stdout);
}
