import { exec } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ExecFn } from "./tmux.js";
import { execCommand } from "./tmux-exec.js";

const execAsync = promisify(exec);

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

/** Production preflight only; callers still prefer an explicitly injected exec. */
export const execPreflightCommand: ExecFn = async (cmd) => {
  const cwd = runtimeVersionProbeCwd(cmd);
  if (cwd === undefined) return execCommand(cmd);
  const { stdout } = await execAsync(cmd, { cwd });
  return stdout;
};

/** Do not echo a runtime's arbitrary output, environment, paths or stack trace.
 * Retain only bounded process status and recognisable failure categories. */
export function runtimeProbeFailure(err: unknown): string {
  if (!err || typeof err !== "object") return "execution failed";
  const failure = err as { code?: unknown; status?: unknown; signal?: unknown; stderr?: unknown; message?: unknown };
  const code = failure.code ?? failure.status;
  const detail: string[] = [];
  if (typeof code === "number" && Number.isSafeInteger(code)) detail.push(`exit status ${code}`);
  else if (typeof code === "string" && ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"].includes(code)) detail.push(code);
  if (["SIGTERM", "SIGKILL", "SIGABRT"].includes(String(failure.signal))) detail.push(String(failure.signal));
  const stderr = Buffer.isBuffer(failure.stderr) ? failure.stderr.toString() : failure.stderr;
  const diagnostic = [stderr, failure.message].filter((value) => typeof value === "string").join("\n");
  if (/\b(?:uv_cwd|getcwd)\b/.test(diagnostic)) detail.push("working-directory lookup failed");
  else if (/(?:command not found|: (?:pi|omp|codex|claude): not found)/.test(diagnostic)) detail.push("executable not found on PATH");
  return detail.join("; ") || "execution failed";
}
