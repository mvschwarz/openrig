import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateTextFileAsync } from "./private-text-file.js";
import { WINDOWS_SEAT_JOB_PREFIX, windowsJobInteropScript } from "./windows-job-process.js";
import { powershellQuote } from "../adapters/windows-launch.js";
import { execWindowsJobFile } from "./windows-job-exec.js";
import { windowsPowerShell } from "./windows-executables.js";
import { readWindowsProcessesStrict, type WindowsProcessRow } from "./windows-process-table.js";
import { isWindowsScopedBootstrap } from "./windows-cmd-bridge.js";

/** Read a live guardian's uniquely named Job, never a stored configuration.
 * Any inaccessible guardian, missing Job or invalid receipt rejects as unknown. */
export async function readWindowsSeatJob(pid: number, targetPid?: number): Promise<{ memoryMax: number; activeProcesses: number }> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || (targetPid !== undefined && (!Number.isSafeInteger(targetPid) || targetPid <= 0))) throw new TypeError("Invalid seat process identity");
  const dir = await mkdtemp(join(tmpdir(), "openrig-seat-job-read-"));
  const file = join(dir, "read.ps1");
  try {
    const script = `${windowsJobInteropScript()}\n$ProgressPreference='SilentlyContinue'\n` +
      `$guardian=[Diagnostics.Process]::GetProcessById(${pid})\n` +
      `try { $ticks=$guardian.StartTime.ToUniversalTime().Ticks; ` +
      `$name=${powershellQuote(WINDOWS_SEAT_JOB_PREFIX)}+$guardian.Id+'-'+$ticks; ` +
      (targetPid !== undefined ? `$target=[Diagnostics.Process]::GetProcessById(${targetPid}); try { [void][OpenRigProbeJob]::ReadSeatJobLimit($name,$target.Handle); if($target.HasExited){throw 'Seat target exited during readback'} } finally {$target.Dispose()}; ` : "") +
      `$result=[OpenRigProbeJob]::ReadSeatJobState($name); ` +
      `if($guardian.HasExited){throw 'Seat guardian exited during readback'}; [Console]::WriteLine($result) } finally {$guardian.Dispose()}\n`;
    await createPrivateTextFileAsync(file, script);
    const { stdout } = await execWindowsJobFile(windowsPowerShell(), ["-NoProfile", "-NonInteractive", "-File", file], { timeout: 15000 });
    const match = /^(\d+)\|(\d+)$/.exec(stdout.trim());
    if (!match) throw new Error("Seat Job readback was malformed");
    const memoryMax = Number(match[1]), activeProcesses = Number(match[2]);
    if (!Number.isSafeInteger(memoryMax) || memoryMax <= 0 || !Number.isSafeInteger(activeProcesses)) throw new Error("Seat Job readback was out of range");
    return { memoryMax, activeProcesses };
  } finally {
    await unlink(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") process.emitWarning(`Seat Job readback script retained at ${file}: ${error.message}`);
    });
    await rmdir(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") process.emitWarning(`Seat Job readback directory retained at ${dir}: ${error.message}`);
    });
  }
}

/** A pane can report an ancestor of its bootstrap. Only a uniquely identified
 * scoped guardian with a live descendant in its named Job is positive proof. */
export async function readWindowsSeatJobForPane(panePid: number, deps: {
  census?: typeof readWindowsProcessesStrict; inspect?: typeof readWindowsSeatJob;
  targetPid?: number;
} = {}): Promise<{ memoryMax: number; activeProcesses: number }> {
  const census = deps.census ?? readWindowsProcessesStrict, inspect = deps.inspect ?? readWindowsSeatJob;
  const rows = await census();
  const root = rows.find(row => row.pid === panePid);
  if (!root?.startedAt || root.identityReadable === false) throw new Error("Pane process identity is unavailable");
  const descendants = (parent: WindowsProcessRow): WindowsProcessRow[] => {
    const result: WindowsProcessRow[] = [], pending = [parent];
    const seen = new Set<number>([parent.pid]);
    while (pending.length) {
      const current = pending.shift()!;
      for (const child of rows.filter(row => row.ppid === current.pid)) {
        if (seen.has(child.pid) || !Number.isFinite(Date.parse(child.startedAt)) || !Number.isFinite(Date.parse(current.startedAt))
          || Date.parse(child.startedAt) < Date.parse(current.startedAt)) throw new Error("Process lineage is ambiguous");
        seen.add(child.pid); result.push(child); pending.push(child);
      }
    }
    return result;
  };
  const subtree = [root, ...descendants(root)];
  const guardians = subtree.filter(row => row.identityReadable !== false && isWindowsScopedBootstrap(row));
  const matches: Array<{ guardian: WindowsProcessRow; target: WindowsProcessRow; result: { memoryMax: number; activeProcesses: number } }> = [];
  for (const guardian of guardians) {
    // The guardian creates exactly one seat root. A later orphaned grandchild
    // cannot by itself prove the original parent chain after the root exits.
    for (const target of descendants(guardian).filter(row => row.ppid === guardian.pid)) {
      if (deps.targetPid !== undefined && target.pid !== deps.targetPid) continue;
      try {
        const result = await inspect(guardian.pid, target.pid);
        if (result.activeProcesses > 0) { matches.push({ guardian, target, result }); break; }
      } catch { /* Another process in the subtree may be the bound target. */ }
    }
  }
  if (matches.length !== 1) throw new Error("Seat guardian and Job membership are not uniquely proven");
  const match = matches[0]!, after = await census();
  for (const prior of [root, match.guardian, match.target]) {
    const current = after.find(row => row.pid === prior.pid);
    if (!current || current.ppid !== prior.ppid || current.startedAt !== prior.startedAt) throw new Error("Seat process identity changed during Job readback");
  }
  return match.result;
}
