import { accessSync, constants } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";

function executable(file: string): boolean {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
}

/**
 * The OS account's configured login shell: the passwd entry, which macOS answers from directory
 * services (`UserShell`) and Linux from NSS (`getent passwd`). `$SHELL` is only a fallback because a
 * process can inherit a stale or different value. Anything that is not an absolute executable path is
 * skipped, and `/bin/sh` is the last resort, so a failed lookup never stops a layout.
 */
export function resolveLoginShell(
  accountShell: () => string | null | undefined = () => userInfo().shell,
  env: NodeJS.ProcessEnv = process.env,
  isExecutable: (file: string) => boolean = executable,
): string {
  let account: string | null | undefined;
  try { account = accountShell(); } catch { account = undefined; }
  for (const shell of [account, env["SHELL"]]) {
    if (shell && path.isAbsolute(shell) && isExecutable(shell)) return shell;
  }
  return "/bin/sh";
}

/** What a grid's filler pane runs: the person's own shell as a login shell, on the host showing the view. */
export function blankShellArgv(): string[] {
  return [resolveLoginShell(), "-l"];
}
