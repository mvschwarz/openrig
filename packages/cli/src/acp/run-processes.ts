import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";

/** Set in the agent's environment by `rig acp run`; every process it launches inherits it, even one that detaches
 *  (PPID 1), which is how a run finds what it started without touching anything it didn't. */
export const RUN_MARKER = "OPENRIG_ACP_RUN";

/** Only the pid: on macOS the listing carries the environment, which may hold secrets, so nothing else leaves here. */
export interface RunProcess { pid: number }

/** The caller's processes carrying this run's marker. Linux reads /proc; elsewhere `ps e` shows own environments. */
export async function findRunProcesses(runId: string): Promise<RunProcess[]> {
  const marker = `${RUN_MARKER}=${runId}`;
  if (process.platform === "linux") {
    const found: RunProcess[] = [];
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const environ = await readFile(`/proc/${entry}/environ`, "utf8");
        if (!environ.split("\0").includes(marker)) continue;
        found.push({ pid: Number(entry) });
      } catch { /* exited, or not ours to read */ }
    }
    return found;
  }
  const { stdout } = await promisify(execFile)("ps", ["axeww", "-o", "pid=,command="], { maxBuffer: 32 * 1024 * 1024 });
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match || !match[2]!.split(/\s+/).includes(marker)) return [];
    return [{ pid: Number(match[1]) }];
  });
}
