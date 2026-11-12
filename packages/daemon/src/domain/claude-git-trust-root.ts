import nodePath from "node:path";
import fs from "node:fs";

/**
 * #2820: the folder whose `projects[<folder>].hasTrustDialogAccepted` Claude Code's strict workspace-trust check reads
 * for a session started in `cwd`, or null outside a git repository.
 *
 * Claude Code (2.1.319 and later) runs with the resolved cwd, walks up from it to the nearest folder holding `.git`,
 * and maps a linked worktree to its main worktree. Its "gated grants" backstop (the "Quick safety check" screen shown
 * when tracked project settings carry `permissions.allow`) accepts trust only at that key, so trusting the seat's own
 * folder is not enough below the root. This mirrors that lookup without spawning git and never throws.
 */
export function claudeStrictTrustRoot(cwd: string): string | null {
  let dir: string;
  try {
    dir = fs.realpathSync.native(cwd);
  } catch {
    return null;
  }
  for (;;) {
    const dotGit = nodePath.join(dir, ".git");
    if (fs.existsSync(dotGit)) return canonicalWorktreeRoot(dir, dotGit);
    const parent = nodePath.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * A `.git` directory: the root itself. A linked worktree's `.git` file (`gitdir: <common>/worktrees/<name>`, whose own
 * `gitdir` file points back at this `.git`): the main worktree's root, or the common dir itself when the repository
 * has no main worktree (bare, or a common dir not named `.git`). Anything else, or any read failure: the root itself.
 */
function canonicalWorktreeRoot(root: string, dotGit: string): string {
  try {
    if (!fs.statSync(dotGit).isFile()) return root;
    const pointer = fs.readFileSync(dotGit, "utf8").trim();
    if (!pointer.startsWith("gitdir:")) return root;
    const gitDirText = pointer.slice("gitdir:".length).trim();
    if (!gitDirText) return root;
    const gitDir = nodePath.resolve(root, gitDirText);
    const commonDirText = readSmallFile(nodePath.join(gitDir, "commondir"));
    if (!commonDirText) return root;
    const commonDir = nodePath.resolve(gitDir, commonDirText);
    if (nodePath.dirname(gitDir) !== nodePath.join(commonDir, "worktrees")) return root;
    // The worktree must point back at this root's `.git`; a forged `.git` file cannot name another repository's root.
    const backLink = readSmallFile(nodePath.join(gitDir, "gitdir"));
    if (!backLink) return root;
    if (fs.realpathSync.native(nodePath.resolve(gitDir, backLink)) !== nodePath.join(fs.realpathSync.native(root), ".git")) return root;
    if (nodePath.basename(commonDir) !== ".git") {
      return fs.existsSync(nodePath.join(commonDir, ".git")) ? root : commonDir;
    }
    return nodePath.dirname(commonDir);
  } catch {
    return root;
  }
}

function readSmallFile(path: string): string | null {
  if (!fs.statSync(path, { throwIfNoEntry: false })?.isFile()) return null;
  return fs.readFileSync(path, "utf8").trim() || null;
}
