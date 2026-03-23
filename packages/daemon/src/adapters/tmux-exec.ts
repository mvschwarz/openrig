import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ExecFn } from "./tmux.js";

const execAsync = promisify(exec);

/**
 * Production ExecFn for TmuxAdapter.
 * Wraps child_process.exec (shell command string) and returns stdout.
 */
export const execCommand: ExecFn = async (cmd: string): Promise<string> => {
  const { stdout } = await execAsync(cmd);
  return stdout;
};
