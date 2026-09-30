import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ArgvExecFn, ExecFn } from "./tmux.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

function extractExecOutput(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const stdout = typeof (err as { stdout?: unknown }).stdout === "string"
    ? (err as { stdout: string }).stdout.trim()
    : "";
  const stderr = typeof (err as { stderr?: unknown }).stderr === "string"
    ? (err as { stderr: string }).stderr.trim()
    : "";
  return [stdout, stderr].filter(Boolean).join("\n");
}

/**
 * Production ExecFn for TmuxAdapter.
 * Wraps child_process.exec (shell command string) and returns stdout.
 */
export const execCommand: ExecFn = async (cmd: string): Promise<string> => {
  try {
    const { stdout } = await execAsync(cmd);
    return stdout;
  } catch (err) {
    const output = extractExecOutput(err);
    if (err instanceof Error && output && !err.message.includes(output)) {
      throw new Error(`${err.message}\n${output}`);
    }
    throw err;
  }
};

/**
 * Production ArgvExecFn for TmuxAdapter (the Windows/psmux path).
 * Runs argv[0] directly via execFile: no shell, no quoting layer. argv[0]
 * stays the literal "tmux" token — psmux ships a `tmux` alias on PATH, so
 * binary resolution is identical to the tmux case.
 */
export const execArgvCommand: ArgvExecFn = async (argv: string[]): Promise<string> => {
  const [bin, ...args] = argv;
  if (!bin) throw new Error("execArgvCommand: empty argv");
  try {
    const { stdout } = await execFileAsync(bin, args, { windowsHide: true });
    return stdout;
  } catch (err) {
    const output = extractExecOutput(err);
    if (err instanceof Error && output && !err.message.includes(output)) {
      throw new Error(`${err.message}\n${output}`);
    }
    throw err;
  }
};
