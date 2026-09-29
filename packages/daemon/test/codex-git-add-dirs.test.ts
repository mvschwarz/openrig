import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

// Issue #121: in a linked git worktree `<cwd>/.git` is a FILE ("gitdir: ..."), so passing it to Codex as
// `--add-dir` breaks the Linux sandbox for every command. These tests use real temporary Git repositories
// and the adapter's real fresh-launch command path; no Codex, daemon or live tmux is started.

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], {
    cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
  });

let root: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "issue121-"))); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function ordinaryRepo(): string {
  const repo = nodePath.join(root, "main repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  return repo;
}

function linkedWorktree(): { repo: string; worktree: string; worktreeGitDir: string } {
  const repo = ordinaryRepo();
  const worktree = nodePath.join(root, "linked worktree");
  git(repo, "worktree", "add", "-q", worktree, "-b", "feature");
  // Git names the per-worktree admin dir itself (it may sanitize the name), so read it from the .git file.
  const worktreeGitDir = fs.readFileSync(nodePath.join(worktree, ".git"), "utf8").replace(/^gitdir:\s*/, "").trim();
  return { repo, worktree, worktreeGitDir };
}

function mockTmux(): TmuxAdapter {
  const tmux = {
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "codex"),
    capturePaneContent: vi.fn(async () => "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything"),
    getPanePid: vi.fn(async () => null),
  } as unknown as TmuxAdapter;
  tmux.sendShellCommand = vi.fn(async (target: string, command: string) => {
    await tmux.sendText(target, command);
    return tmux.sendKeys(target, ["Enter"]);
  });
  return tmux;
}

const fsOps: CodexAdapterFsOps = {
  readFile: (p: string) => { throw new Error(`Not found: ${p}`); },
  writeFile: () => {},
  exists: () => false,
  mkdirp: () => {},
};

function binding(cwd: string): NodeBinding {
  return {
    id: "b1", nodeId: "n1", tmuxSession: "r01-qa", tmuxWindow: null, tmuxPane: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd,
  };
}

async function freshLaunchCommand(cwd: string): Promise<string> {
  const tmux = mockTmux();
  const adapter = new CodexRuntimeAdapter({
    tmux, fsOps, sleep: async () => {}, listProcesses: () => [], readThreadIdByPid: () => undefined,
  });
  await adapter.launchHarness(binding(cwd), { name: "dev@issue121-rig" });
  return vi.mocked(tmux.sendText).mock.calls[0]![1] as string;
}

function addDirs(command: string): string[] {
  const out: string[] = [];
  const re = / --add-dir '((?:[^']|'"'"')*)'/g;
  for (let m = re.exec(command); m; m = re.exec(command)) out.push(m[1]!.replace(/'"'"'/g, "'"));
  return out;
}

describe("Codex fresh launch git add-dirs (issue #121)", () => {
  it("ordinary repository keeps --add-dir <cwd>/.git", async () => {
    const repo = ordinaryRepo();
    const dirs = addDirs(await freshLaunchCommand(repo));
    expect(dirs).toContain(nodePath.join(repo, ".git"));
  });

  it("linked worktree never passes the .git FILE; it passes the worktree git dir and the common git dir", async () => {
    const { repo, worktree, worktreeGitDir } = linkedWorktree();
    expect(fs.statSync(nodePath.join(worktree, ".git")).isFile()).toBe(true);
    const dirs = addDirs(await freshLaunchCommand(worktree));
    expect(dirs).not.toContain(nodePath.join(worktree, ".git"));
    expect(dirs).toContain(worktreeGitDir);
    expect(dirs).toContain(nodePath.join(repo, ".git"));
    for (const dir of dirs) expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it("resume does not resolve or add git dirs (unchanged)", async () => {
    const tmux = mockTmux();
    const resolveGitAddDirs = vi.fn(async () => ["/should/not/appear"]);
    const adapter = new CodexRuntimeAdapter({
      tmux, fsOps, sleep: async () => {}, listProcesses: () => [], readThreadIdByPid: () => undefined, resolveGitAddDirs,
    });
    await adapter.launchHarness(binding(root), { name: "dev@issue121-rig", resumeToken: "thread-1" });
    expect(resolveGitAddDirs).not.toHaveBeenCalled();
    expect(vi.mocked(tmux.sendText).mock.calls[0]![1]).not.toContain("/should/not/appear");
  });
});

describe("resolveCodexGitAddDirs (issue #121)", () => {
  it("ordinary repository: [<cwd>/.git]", async () => {
    const { resolveCodexGitAddDirs } = await import("../src/domain/codex-git-add-dirs.js");
    const repo = ordinaryRepo();
    expect(await resolveCodexGitAddDirs(repo)).toEqual([nodePath.join(repo, ".git")]);
  });

  it("missing .git: [<cwd>/.git], unchanged", async () => {
    const { resolveCodexGitAddDirs } = await import("../src/domain/codex-git-add-dirs.js");
    const plain = nodePath.join(root, "not a repo");
    fs.mkdirSync(plain);
    expect(await resolveCodexGitAddDirs(plain)).toEqual([nodePath.join(plain, ".git")]);
  });

  it("linked worktree: worktree git dir and common git dir, both existing directories", async () => {
    const { resolveCodexGitAddDirs } = await import("../src/domain/codex-git-add-dirs.js");
    const { repo, worktree, worktreeGitDir } = linkedWorktree();
    expect(await resolveCodexGitAddDirs(worktree)).toEqual([worktreeGitDir, nodePath.join(repo, ".git")]);
  });

  it("malformed .git file (gitdir points nowhere): [], never the file", async () => {
    const { resolveCodexGitAddDirs } = await import("../src/domain/codex-git-add-dirs.js");
    const broken = nodePath.join(root, "broken worktree");
    fs.mkdirSync(broken);
    fs.writeFileSync(nodePath.join(broken, ".git"), `gitdir: ${nodePath.join(root, "missing", "worktrees", "x")}\n`);
    expect(await resolveCodexGitAddDirs(broken)).toEqual([]);
  });

  it("unreadable .git (not ENOENT): []", async () => {
    const { resolveCodexGitAddDirs } = await import("../src/domain/codex-git-add-dirs.js");
    const parent = nodePath.join(root, "locked");
    fs.mkdirSync(parent);
    const cwd = nodePath.join(parent, "cwd");
    fs.mkdirSync(cwd);
    fs.chmodSync(parent, 0o000);
    try {
      // stat of <cwd>/.git fails with EACCES when the parent is not searchable (non-root users).
      const result = await resolveCodexGitAddDirs(cwd);
      if (process.getuid && process.getuid() === 0) expect(Array.isArray(result)).toBe(true);
      else expect(result).toEqual([]);
    } finally {
      fs.chmodSync(parent, 0o755);
    }
  });
});
