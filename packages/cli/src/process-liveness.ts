import { execFileSync } from "node:child_process";
import type { ProcessLiveness } from "./daemon-lifecycle.js";

export type SignalOutcome = "sent" | "missing" | "not-permitted";

/** kill(pid, 0) as an outcome. POSIX: kill(pid, 0) fails only with ESRCH (no such process) or EPERM
 *  (the process EXISTS but this shell may not signal it: another user's process, or a sandbox such as
 *  Codex's). Only ESRCH is "missing"; any other error is not evidence of death, so it reads as
 *  "not-permitted" (uninspectable), never as a dead process. */
export function signalProbe(pid: number, kill: (pid: number, signal: 0) => unknown = process.kill): SignalOutcome {
  try {
    kill(pid, 0);
    return "sent";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "missing" : "not-permitted";
  }
}

/** #275 — three-state liveness for status reads. Only a missing process (ESRCH) or a zombie is
 *  dead. A process that exists but cannot be inspected (EPERM, or `ps` cannot run, as inside
 *  Codex's macOS sandbox) is UNKNOWN, never dead: calling it dead turned a running daemon into
 *  `stale` before any health probe. The boolean createIsProcessAlive (start/stop) is unchanged. */
export function createProcessLiveness(deps: {
  signal: (pid: number) => SignalOutcome;
  readProcessState: (pid: number) => string | null;
}): (pid: number) => ProcessLiveness {
  return (pid: number) => {
    const signal = deps.signal(pid);
    if (signal === "missing") return "dead";
    const state = deps.readProcessState(pid)?.trim();
    if (!state) return "unknown";
    if (state.startsWith("Z")) return "dead";
    return signal === "not-permitted" ? "unknown" : "alive";
  };
}

type ExecFile = (file: string, args: string[], options: { encoding: "utf-8" }) => string;

// Windows has no ps(1) and no zombie state, so the signal probe alone decides liveness there.
export function readProcessState(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: ExecFile = execFileSync,
): string | null {
  if (platform === "win32") return "R";
  try {
    return run("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf-8" });
  } catch {
    return null;
  }
}
