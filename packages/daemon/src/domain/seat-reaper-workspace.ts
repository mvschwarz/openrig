import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
const workspace = z.object({ workspaceRoot: z.string(), repos: z.array(z.object({ path: z.string().min(1) })),
  knowledgeRoot: z.string().optional() });
export type WorkspaceProbe = "clean" | "dirty-workspace" | "defer-probe-failed";

export function reapWorkspacePaths(raw: string | null, cwds: readonly string[]): readonly string[] {
  if (raw === null) return [...new Set(cwds)];
  const parsed = workspace.parse(JSON.parse(raw));
  return [...new Set([...parsed.repos.map(repo => repo.path), ...(parsed.knowledgeRoot ? [parsed.knowledgeRoot] : []), ...cwds])];
}

// #3836 review: inherited repo-location variables can point the probe at another clean
// repository and report a dirty workspace as clean. Strip them before spawning git.
const REPO_LOCATION_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR"];

export async function probeReapWorkspace(paths: readonly string[]): Promise<WorkspaceProbe> {
  if (paths.length === 0) return "defer-probe-failed";
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !REPO_LOCATION_VARS.includes(key)));
    for (const cwd of paths) {
      const options = { cwd, timeout: 10_000, maxBuffer: 1024 * 1024, env: { ...env, GIT_OPTIONAL_LOCKS: "0" } };
      // --ignore-submodules=none: repository config (submodule.<name>.ignore=all) must not
      // be able to hide dirty-submodule evidence from the safety probe.
      const status = await exec("git", ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"], options);
      if (status.stdout.trim()) return "dirty-workspace";
      // Missing upstream, detached HEAD or unreadable history is uncertainty, not proof of a pushed tree.
      const ahead = await exec("git", ["rev-list", "--count", "@{upstream}..HEAD"], options);
      if (!/^\d+\s*$/.test(ahead.stdout)) return "defer-probe-failed";
      if (Number(ahead.stdout) > 0) return "dirty-workspace";
    }
    return "clean";
  } catch (error) {
    if (error instanceof Error) return "defer-probe-failed";
    throw error;
  }
}
