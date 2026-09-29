import { execFile } from "node:child_process";
import fs from "node:fs";
import nodePath from "node:path";

/** The git metadata directories a Codex workspace-write seat may write, for its fresh-launch `--add-dir`s. */
export type CodexGitAddDirResolver = (cwd: string) => Promise<string[]>;

const GIT_TIMEOUT_MS = 5000;

/**
 * Issue #121. `<cwd>/.git` is a directory in an ordinary repository, but a FILE ("gitdir: ...") in a linked
 * worktree or submodule; Codex's Linux sandbox cannot mount under a file, so passing it breaks every command.
 *
 * - `.git` is a directory: `[<cwd>/.git]`, as before.
 * - `.git` does not exist: `[<cwd>/.git]`, as before. Nothing reported fails for this case, and changing it
 *   is outside the fix.
 * - `.git` is a file: the absolute git dir and common git dir from `git rev-parse`, keeping only existing
 *   directories (a linked worktree needs both to commit).
 * - Anything unresolvable (unreadable `.git`, malformed gitdir, git missing or failing): `[]`. The seat still
 *   launches; it simply gets no extra git write access, instead of a broken path that fails every command.
 */
export const resolveCodexGitAddDirs: CodexGitAddDirResolver = async (cwd) => {
  const dotGit = nodePath.join(cwd, ".git");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [dotGit] : [];
  }
  if (stat.isDirectory()) return [dotGit];
  const stdout = await new Promise<string | null>((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      { timeout: GIT_TIMEOUT_MS, encoding: "utf8" },
      (error, out) => resolve(error ? null : out),
    );
  });
  if (stdout === null) return [];
  const dirs = [...new Set(stdout.split("\n").map((line) => line.trim()).filter(Boolean))];
  return dirs.filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
};
