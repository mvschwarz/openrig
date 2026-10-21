import { statSync } from "node:fs";
import path from "node:path";
import { boundedProbeExec, ProbeTimeoutError } from "./bounded-probe-exec.js";
import type { ExecFn } from "./tmux.js";
import { execCommand } from "./tmux-exec.js";

/** Preserve healthy relative PATH lookup; use the executable's filesystem root
 * only when the daemon's inherited cwd is unavailable. Profile/config probes
 * and all other commands keep their existing context. */
export function runtimeVersionProbeCwd(cmd: string): string | undefined {
  if (!/^(pi|omp|codex|claude) --version$/.test(cmd)) return undefined;
  try {
    const cwd = process.cwd();
    // Node can cache cwd even after the directory has been removed.
    if (statSync(cwd).isDirectory()) return cwd;
  } catch { /* Unavailable cwd: a version probe can run from the root. */ }
  return path.parse(process.execPath).root;
}

/** Runtime version probes: bounded, and their process group is ended, like the verifier's probes. A hung
 *  runtime binary otherwise holds a rig launch (or the daemon's startup) indefinitely and outlives the daemon. */
const versionProbe = boundedProbeExec(undefined, undefined, { cwd: runtimeVersionProbeCwd });

/** Production preflight only; callers still prefer an explicitly injected exec. */
export const execPreflightCommand: ExecFn = async (cmd) => {
  if (runtimeVersionProbeCwd(cmd) === undefined) return execCommand(cmd);
  return versionProbe(cmd);
};

/** The message for a version check that hit its time limit: the check and the limit, nothing from the runtime.
 *  Undefined for any other failure. */
export function runtimeProbeTimeout(err: unknown): string | undefined {
  if (!(err instanceof ProbeTimeoutError)) return undefined;
  return `\`${err.command}\` didn't answer within ${Math.round(err.timeoutMs / 1000)} s`;
}

/** Do not echo a runtime's arbitrary output, environment, paths or stack trace.
 * Retain only bounded process status and recognisable failure categories. */
export function runtimeProbeFailure(err: unknown): string {
  if (!err || typeof err !== "object") return "execution failed";
  const failure = err as { code?: unknown; status?: unknown; signal?: unknown; stderr?: unknown; message?: unknown };
  const code = failure.code ?? failure.status;
  const detail: string[] = [];
  if (code === "ESTOPPED") return "check cut short: the daemon is stopping";
  if (typeof code === "number" && Number.isSafeInteger(code)) detail.push(`exit status ${code}`);
  else if (typeof code === "string" && ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"].includes(code)) detail.push(code);
  if (["SIGTERM", "SIGKILL", "SIGABRT"].includes(String(failure.signal))) detail.push(String(failure.signal));
  const stderr = Buffer.isBuffer(failure.stderr) ? failure.stderr.toString() : failure.stderr;
  const diagnostic = [stderr, failure.message].filter((value) => typeof value === "string").join("\n");
  if (/\b(?:uv_cwd|getcwd)\b/.test(diagnostic)) detail.push("working-directory lookup failed");
  else if (/(?:command not found|: (?:pi|omp|codex|claude): not found)/.test(diagnostic)) detail.push("executable not found on PATH");
  return detail.join("; ") || "execution failed";
}
