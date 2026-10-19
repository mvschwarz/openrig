import { statSync } from "node:fs";
import { homedir } from "node:os";

/** Keep the caller's cwd unless its directory has been removed while the TUI was open. */
export function helperCwd(): string | undefined {
  try {
    const cwd = process.cwd();
    // Node can return a cached cwd even after the directory is deleted.
    statSync(cwd);
    return cwd;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? homedir() : undefined;
  }
}
