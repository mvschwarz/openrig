import { windowsPowerShell } from "./windows-executables.js";
import { execFile, execFileSync } from "node:child_process";
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
  /** PID/parent are observed, but identity fields are unreadable. Empty fields
   * carry no identity evidence; keep the live PID in absence/lineage checks. */
  identityReadable?: false;
}
const exec = promisify(execFile);
const CENSUS_TIMEOUT_MS = 5000;

/** The same CIM creation stamp as the census, without requiring readable argv.
 * Lifecycle reservations need one exact PID synchronously, never an empty-table fallback. */
export function readWindowsProcessStartToken(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; "
    + `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop; `
    + "if($p -and $p.CreationDate){[Console]::Write($p.CreationDate.ToUniversalTime().ToString('o'))}";
  try {
    const stamp = execFileSync(windowsPowerShell(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script,"utf16le").toString("base64")],
      { encoding: "utf8", windowsHide: true, timeout: CENSUS_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return stamp && Number.isFinite(Date.parse(stamp)) ? `windows:${stamp}` : undefined;
  } catch { return undefined; }
}

/** CIM supplies executable identity and creation time, never POSIX foreground groups. */
export function parseWindowsProcesses(output: string): WindowsProcessRow[] {
  const rows: unknown = JSON.parse(output.replace(/^\uFEFF/, ""));
  if (!Array.isArray(rows)) throw new Error("Windows process census was not an array");
  return rows.flatMap((value): WindowsProcessRow[] => {
    const row = value as Record<string, unknown>;
    if (row?.ProcessId === 0) return []; // The system idle pseudo-process is never a launch PID.
    if (!row || !Number.isSafeInteger(row.ProcessId) || Number(row.ProcessId) <= 0
      || !Number.isSafeInteger(row.ParentProcessId) || Number(row.ParentProcessId) < 0) {
      throw new Error("Windows process census has an unreadable PID or parent; absence is unproven");
    }
    const identityReadable = typeof row.Name === "string" && row.Name.length > 0
      && typeof row.ExecutablePath === "string" && row.ExecutablePath.length > 0
      && typeof row.CommandLine === "string" && row.CommandLine.length > 0 && typeof row.StartedAt === "string"
      && Number.isFinite(Date.parse(row.StartedAt));
    return [{ platform: "win32", pid: Number(row.ProcessId), ppid: Number(row.ParentProcessId),
      executableName: typeof row.Name === "string" ? row.Name : "",
      executablePath: typeof row.ExecutablePath === "string" ? row.ExecutablePath : "",
      command: typeof row.CommandLine === "string" ? row.CommandLine : "",
      startedAt: typeof row.StartedAt === "string" ? row.StartedAt : "",
      ...(!identityReadable ? { identityReadable: false as const } : {}) }];
  });
}

/** Reject a failed query rather than caching a successful empty census. */
export async function readWindowsProcessesStrict(run = exec): Promise<WindowsProcessRow[]> {
  const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,@{n='StartedAt';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}}}) | ConvertTo-Json -Compress";
  let stdout: string;
  try {
    ({ stdout } = await run(windowsPowerShell(),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { encoding: "utf8", windowsHide: true, timeout: CENSUS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }));
  } catch (error) {
    if (error instanceof Error && "killed" in error && error.killed === true
      && "code" in error && error.code === null && "signal" in error && error.signal === "SIGTERM") {
      error.message = `Windows process census timed out after ${CENSUS_TIMEOUT_MS}ms`;
    }
    throw error;
  }
  return parseWindowsProcesses(stdout);
}
