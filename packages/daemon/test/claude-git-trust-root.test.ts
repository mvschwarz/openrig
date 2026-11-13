// #2820: the layouts claudeStrictTrustRoot maps besides the plain repo, symlink and linked worktree covered in
// claude-trust-git-root.test.ts. Each expectation follows Claude Code 2.1.319's canonical-root lookup: a bare common
// dir is its own key, a `.git` file that is not a linked worktree (separate git dir, submodule) keeps its own root, and
// a worktree whose back-link does not point at this `.git` is not mapped to another repository.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeStrictTrustRoot } from "../src/domain/claude-git-trust-root.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
const git = (cwd: string, ...args: string[]) => execFileSync("git",
  ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "init.defaultBranch=main",
    "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", ...args],
  { cwd, env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] });

function tmp() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-git-trust-root-")));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function repoWithCommit(dir: string) {
  fs.mkdirSync(path.join(dir, "seat"), { recursive: true });
  fs.writeFileSync(path.join(dir, "seat", "file.txt"), "x\n");
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seat");
}

describe.skipIf(process.platform === "win32")("claudeStrictTrustRoot (#2820)", () => {
  it("a missing cwd or a folder outside git has no root", () => {
    const root = tmp();
    expect(claudeStrictTrustRoot(path.join(root, "missing"))).toBeNull();
    fs.mkdirSync(path.join(root, "plain", "seat"), { recursive: true });
    expect(claudeStrictTrustRoot(path.join(root, "plain", "seat"))).toBeNull();
  });

  it("a worktree of a bare repository maps to the bare common dir", () => {
    const root = tmp();
    repoWithCommit(path.join(root, "src"));
    git(root, "clone", "-q", "--bare", path.join(root, "src"), path.join(root, "bare.git"));
    git(path.join(root, "bare.git"), "worktree", "add", "-q", "--detach", path.join(root, "wt"));
    expect(claudeStrictTrustRoot(path.join(root, "wt", "seat"))).toBe(path.join(root, "bare.git"));
  });

  it("a separate git dir and a submodule keep their own root", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "sep", "seat"), { recursive: true });
    git(path.join(root, "sep"), "init", "-q", "--separate-git-dir", path.join(root, "sep-git"));
    expect(claudeStrictTrustRoot(path.join(root, "sep", "seat"))).toBe(path.join(root, "sep"));

    repoWithCommit(path.join(root, "child"));
    repoWithCommit(path.join(root, "parent"));
    git(path.join(root, "parent"), "submodule", "add", "-q", path.join(root, "child"), "sub");
    expect(claudeStrictTrustRoot(path.join(root, "parent", "sub", "seat"))).toBe(path.join(root, "parent", "sub"));
  });

  it("a .git file naming another repository's worktree, whose back-link points elsewhere, keeps its own root", () => {
    const root = tmp();
    repoWithCommit(path.join(root, "victim"));
    git(path.join(root, "victim"), "worktree", "add", "-q", "--detach", path.join(root, "real-wt"));
    const forged = path.join(root, "forged");
    fs.mkdirSync(path.join(forged, "seat"), { recursive: true });
    fs.writeFileSync(path.join(forged, ".git"), `gitdir: ${path.join(root, "victim", ".git", "worktrees", "real-wt")}\n`);
    expect(claudeStrictTrustRoot(path.join(root, "real-wt", "seat"))).toBe(path.join(root, "victim"));
    expect(claudeStrictTrustRoot(path.join(forged, "seat"))).toBe(forged);
  });
});
