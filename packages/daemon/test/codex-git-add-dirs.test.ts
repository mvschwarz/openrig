import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { codexCommandResumeToken, observeCodexForkProcess, observeCodexPaneProcess } from "../src/domain/native-process-lineage.js";
import { prepareCodexSeatFolder } from "../src/domain/codex-team-workspace.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { resolveCodexGitAddDirs } from "../src/domain/codex-git-add-dirs.js";
import { shellWords } from "../src/domain/seat-restart-in-place.js";

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

  it.each(["metadata ", "metadata\t"])("preserves whitespace in separate Git metadata directory %j", async (name) => {
    const repo = nodePath.join(root, "separate repo");
    const metadata = nodePath.join(root, name);
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "--separate-git-dir", metadata);
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    expect(fs.statSync(nodePath.join(repo, ".git")).isFile()).toBe(true);
    const dirs = addDirs(await freshLaunchCommand(repo));
    expect(dirs).toContain(metadata);
    for (const dir of dirs) expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

});

// A restored seat resumes its conversation (`codex resume`), and a forked one starts from its parent's
// (`codex fork`). Each must get the git metadata dirs its fresh launch gets, or it can't commit after a restore.
describe("Codex resume and fork git add-dirs (a restored seat keeps .git writable)", () => {
  async function launchCommand(cwd: string, opts: { resumeToken?: string; fork?: true }): Promise<string> {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux, fsOps, sleep: async () => {}, listProcesses: () => [], readThreadIdByPid: () => undefined, resumeProofWindowMs: 0,
    });
    await adapter.launchHarness(binding(cwd), {
      name: "dev@issue121-rig",
      ...(opts.resumeToken ? { resumeToken: opts.resumeToken } : {}),
      ...(opts.fork ? { forkSource: { kind: "native_id" as const, value: "parent-thread", pendingIdAllowed: true } } : {}),
    });
    return vi.mocked(tmux.sendText).mock.calls[0]![1] as string;
  }

  it("an ordinary repository's resume and fork add <cwd>/.git, as its fresh launch does", async () => {
    const repo = ordinaryRepo();
    const fresh = addDirs(await freshLaunchCommand(repo));
    expect(fresh).toEqual([nodePath.join(repo, ".git")]);
    const resume = await launchCommand(repo, { resumeToken: "thread-1" });
    expect(addDirs(resume)).toEqual(fresh);
    // The dirs are resume's own options, after the conversation id.
    expect(resume).toMatch(/ resume 'thread-1' --add-dir '[^']*\/\.git'$/);
    const fork = await launchCommand(repo, { fork: true });
    expect(addDirs(fork)).toEqual(fresh);
    expect(fork).toMatch(/ fork 'parent-thread' --add-dir '[^']*\/\.git'$/);
  });

  it("the resume and fork proofs still find the process when the cwd has a space, which ps does not quote", async () => {
    const repo = ordinaryRepo();
    expect(repo).toContain(" ");
    // ps shows argv joined by spaces with no quoting; this models that line for the launched Codex.
    const asPs = (command: string) => command.slice(command.indexOf("codex ")).replace(/'/g, "");
    const pane = { getPanePid: async () => 4100 };
    const row = (command: string) => [{ pid: 4100, ppid: 1, pgid: 4100, tpgid: 4100, executableName: "codex",
      startedAt: "Sat Jan  1 12:00:00 2000", command: asPs(command), argv: shellWords(command.slice(command.indexOf("codex "))) }];
    const resume = await launchCommand(repo, { resumeToken: "thread-1" });
    expect(codexCommandResumeToken(asPs(resume))).toBe("thread-1");
    expect(await observeCodexPaneProcess({ target: "r01-qa", tmux: pane, listProcesses: () => row(resume),
      expectedToken: "thread-1", requireResume: true })).not.toBeNull();
    const fork = await launchCommand(repo, { fork: true });
    expect(await observeCodexForkProcess({ target: "r01-qa", tmux: pane, listProcesses: () => row(fork),
      parentToken: "parent-thread" })).not.toBeNull();
  });

  it("a linked worktree's resume and fork add its worktree and common git dirs, never the .git file", async () => {
    const { repo, worktree, worktreeGitDir } = linkedWorktree();
    for (const command of [await launchCommand(worktree, { resumeToken: "thread-1" }), await launchCommand(worktree, { fork: true })]) {
      const dirs = addDirs(command);
      expect(dirs).toEqual(addDirs(await freshLaunchCommand(worktree)));
      expect(dirs).toContain(worktreeGitDir);
      expect(dirs).toContain(nodePath.join(repo, ".git"));
      expect(dirs).not.toContain(nodePath.join(worktree, ".git"));
    }
  });

  it("an in-place restart keeps the running Codex's own --add-dirs and resolves none again", async () => {
    const resolveGitAddDirs = vi.fn(async () => ["/should/not/appear"]);
    const adapter = new CodexRuntimeAdapter({
      tmux: mockTmux(), fsOps, sleep: async () => {}, listProcesses: () => [], readThreadIdByPid: () => undefined, resolveGitAddDirs,
    });
    const built = await adapter.buildResumeCommand(binding(root), {
      name: "dev@issue121-rig", resumeToken: "thread-1",
      running: { networkOverride: false, daemonOptOut: false, addDirs: [nodePath.join(root, ".git")] },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(addDirs(built.core)).toEqual([nodePath.join(root, ".git")]);
    expect(resolveGitAddDirs).not.toHaveBeenCalled();
  });

  it("an in-place restart's relaunch is still proven, and still reachable by a send, when a running --add-dir has a space", async () => {
    const repo = ordinaryRepo();
    expect(repo).toContain(" ");
    const adapter = new CodexRuntimeAdapter({
      tmux: mockTmux(), fsOps, sleep: async () => {}, listProcesses: () => [], readThreadIdByPid: () => undefined,
    });
    const built = await adapter.buildResumeCommand(binding(repo), {
      name: "dev@issue121-rig", resumeToken: "thread-1",
      running: { networkOverride: false, daemonOptOut: false, addDirs: ["/shared/state", nodePath.join(repo, ".git")] },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // The dirs are resume's own options, after the conversation id, as on every other resume.
    expect(built.core).toMatch(/ resume 'thread-1' --add-dir '\/shared\/state' --add-dir '[^']* repo\/\.git'$/);
    // The process line joins argv with spaces and no quoting, so a dir before the id would hide it.
    const line = built.core.replace(/'/g, "");
    expect(codexCommandResumeToken(line)).toBe("thread-1");
    const rows = () => [{ pid: 4100, ppid: 1, pgid: 4100, tpgid: 4100, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000",
      command: line, argv: shellWords(built.core) }];
    const pane = { getPanePid: async () => 4100 };
    // The restart's own proof, then the send path's check behind a shell.
    expect(await observeCodexPaneProcess({ target: "r01-qa", tmux: pane, listProcesses: rows, expectedToken: "thread-1", requireResume: true })).not.toBeNull();
    expect(await observeCodexPaneProcess({ target: "r01-qa", tmux: pane, listProcesses: rows, expectedToken: "thread-1" })).not.toBeNull();
  });
});

// A seat's own topology folder holds its LEARNED.md and recap. A default workspace-write Codex seat can write there only
// when its launch names the folder, so fresh, resume and fork add it, after the git dirs and after any conversation id.
describe("Codex seat folder add-dir (a seat keeps its LEARNED.md and recap writable)", () => {
  const seatFolderFor = () => nodePath.join(root, "topology root", "rigs", "issue121-rig", "seats", "dev");
  async function launchCommand(cwd: string, opts: { resumeToken?: string; fork?: true } = {}): Promise<string> {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux, fsOps, sleep: async () => {}, listProcesses: () => [], readThreadIdByPid: () => undefined, resumeProofWindowMs: 0,
      prepareSeatFolder: (session) => session === "dev@issue121-rig" ? seatFolderFor() : undefined,
    });
    await adapter.launchHarness(binding(cwd), {
      name: "dev@issue121-rig",
      ...(opts.resumeToken ? { resumeToken: opts.resumeToken } : {}),
      ...(opts.fork ? { forkSource: { kind: "native_id" as const, value: "parent-thread", pendingIdAllowed: true } } : {}),
    });
    return vi.mocked(tmux.sendText).mock.calls[0]![1] as string;
  }

  it("fresh, resume and fork each add the seat's own folder after the git dirs", async () => {
    const repo = ordinaryRepo();
    const expected = [nodePath.join(repo, ".git"), seatFolderFor()];
    expect(addDirs(await launchCommand(repo))).toEqual(expected);
    const resume = await launchCommand(repo, { resumeToken: "thread-1" });
    expect(addDirs(resume)).toEqual(expected);
    expect(resume).toMatch(/ resume 'thread-1' --add-dir '[^']*\/\.git' --add-dir '[^']*\/seats\/dev'$/);
    const fork = await launchCommand(repo, { fork: true });
    expect(addDirs(fork)).toEqual(expected);
    expect(fork).toMatch(/ fork 'parent-thread' --add-dir '[^']*\/\.git' --add-dir '[^']*\/seats\/dev'$/);
  });

  it("the resume and fork proofs still find the process when the seat folder's path has a space", async () => {
    const repo = ordinaryRepo();
    expect(seatFolderFor()).toContain(" ");
    const asPs = (command: string) => command.slice(command.indexOf("codex ")).replace(/'/g, "");
    const pane = { getPanePid: async () => 4100 };
    const row = (command: string) => [{ pid: 4100, ppid: 1, pgid: 4100, tpgid: 4100, executableName: "codex",
      startedAt: "Sat Jan  1 12:00:00 2000", command: asPs(command), argv: shellWords(command.slice(command.indexOf("codex "))) }];
    const resume = await launchCommand(repo, { resumeToken: "thread-1" });
    expect(codexCommandResumeToken(asPs(resume))).toBe("thread-1");
    expect(await observeCodexPaneProcess({ target: "r01-qa", tmux: pane, listProcesses: () => row(resume),
      expectedToken: "thread-1", requireResume: true })).not.toBeNull();
    const fork = await launchCommand(repo, { fork: true });
    expect(await observeCodexForkProcess({ target: "r01-qa", tmux: pane, listProcesses: () => row(fork),
      parentToken: "parent-thread" })).not.toBeNull();
  });
});

// A Codex seat without a pod restores through CodexResumeAdapter (a seat in a pod resumes through the launch adapter,
// which #2000 already covers). It gets the same git dirs a fresh launch gets, from the real resolver, so it can still commit.
describe("Codex restore-path git add-dirs (a pod-less seat restored through CodexResumeAdapter keeps .git writable)", () => {
  async function restoreCommand(cwd: string): Promise<string> {
    const tmux = mockTmux();
    await new CodexResumeAdapter(tmux, { resolveGitAddDirs: resolveCodexGitAddDirs, pollMs: 1, maxWaitMs: 1, sleep: async () => {}, listProcesses: () => [] })
      .resume("dev@issue121-rig", "codex_id", "thread-1", cwd);
    return vi.mocked(tmux.sendText).mock.calls[0]![1] as string;
  }

  it("an ordinary repository's restore adds <cwd>/.git, as its fresh launch does, after the conversation id", async () => {
    const repo = ordinaryRepo();
    const restore = await restoreCommand(repo);
    expect(addDirs(restore)).toEqual(addDirs(await freshLaunchCommand(repo)));
    expect(restore).toMatch(/ resume 'thread-1' --add-dir '[^']*\/\.git'$/);
    // ps shows argv unquoted; the id is still read when the cwd has a space.
    expect(repo).toContain(" ");
    expect(codexCommandResumeToken(restore.slice(restore.indexOf("codex ")).replace(/'/g, ""))).toBe("thread-1");
  });

  it("a linked worktree's restore adds its worktree and common git dirs, never the .git file", async () => {
    const { repo, worktree, worktreeGitDir } = linkedWorktree();
    const dirs = addDirs(await restoreCommand(worktree));
    expect(dirs).toEqual(addDirs(await freshLaunchCommand(worktree)));
    expect(dirs).toContain(worktreeGitDir);
    expect(dirs).toContain(nodePath.join(repo, ".git"));
    expect(dirs).not.toContain(nodePath.join(worktree, ".git"));
  });
});

describe("prepareCodexSeatFolder", () => {
  it("creates and returns exactly <topology root>/rigs/<rig>/seats/<seat>, and reuses it", () => {
    const topology = nodePath.join(root, "topology");
    const folder = nodePath.join(topology, "rigs", "my-rig", "seats", "dev-qa");
    expect(prepareCodexSeatFolder("dev-qa@my-rig", topology)).toBe(folder);
    expect(fs.statSync(folder).isDirectory()).toBe(true);
    fs.writeFileSync(nodePath.join(folder, "LEARNED.md"), "kept\n");
    expect(prepareCodexSeatFolder("dev-qa@my-rig", topology)).toBe(folder);
    expect(fs.readFileSync(nodePath.join(folder, "LEARNED.md"), "utf8")).toBe("kept\n");
  });

  it.each(["dev-qa", "../escape@my-rig", ".hidden@my-rig", "dev qa@my-rig"])("gives none for %j and creates nothing", (name) => {
    const topology = nodePath.join(root, "topology");
    expect(prepareCodexSeatFolder(name, topology)).toBeUndefined();
    expect(fs.existsSync(topology)).toBe(false);
  });

  it("refuses a symlinked segment and creates nothing at its target", () => {
    const topology = nodePath.join(root, "topology");
    const elsewhere = nodePath.join(root, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(nodePath.join(topology, "rigs", "my-rig"), { recursive: true });
    fs.symlinkSync(elsewhere, nodePath.join(topology, "rigs", "my-rig", "seats"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(prepareCodexSeatFolder("dev-qa@my-rig", topology)).toBeUndefined();
      expect(fs.readdirSync(elsewhere)).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("gives none for a relative topology root", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(prepareCodexSeatFolder("dev-qa@my-rig", "relative/topology")).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
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
