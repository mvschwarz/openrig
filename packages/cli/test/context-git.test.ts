import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addGitContext, inspectGitContext, updateGitContext } from "../src/lib/context-git.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function git(path: string, ...args: string[]) {
  return execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function commit(path: string, message: string) { git(path, "add", "."); git(path, "-c", "user.name=Context Test", "-c", "user.email=context@example.invalid", "commit", "-m", message); }
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "openrig-git-context-")); homes.push(home);
  const upstream = join(home, "upstream"); mkdirSync(upstream);
  git(upstream, "init", "-b", "main");
  const pack = ".openrig/context-packs/guide";
  mkdirSync(join(upstream, pack), { recursive: true });
  writeFileSync(join(upstream, pack, "manifest.yaml"), "name: guide\nversion: 1\ntaxonomy: world\nfiles:\n  - path: upstream.md\n    role: reference\n  - path: local.md\n    role: reference\n");
  writeFileSync(join(upstream, pack, "upstream.md"), "Revision A\n");
  writeFileSync(join(upstream, pack, "local.md"), "Local original\n");
  commit(upstream, "A");
  const root = join(home, "context");
  const add = addGitContext(upstream, {}, root);
  git(add.selected.checkout, "config", "user.name", "Context Test");
  git(add.selected.checkout, "config", "user.email", "context@example.invalid");
  const original = readFileSync(join(add.selected.checkout, pack, "upstream.md"), "utf8");
  return { home, upstream, pack, root, target: add.installedAt, checkout: add.selected.checkout, a: add.selected.revision, original };
}

describe("Git context selections preserve author work", () => {
  it("refuses a real checkout subdirectory before selecting any context", () => {
    const f = fixture();
    expect(() => addGitContext(join(f.upstream, f.pack), { checkout: true, name: "nested" }, f.root)).toThrow(/checkout root, not a subdirectory/);
    expect(existsSync(join(f.root, "nested"))).toBe(false);
    expect(git(f.upstream, "rev-parse", "HEAD")).toBe(f.a);
  });

  it("discovers a repository pack, merges upstream B with a local commit and serves both", () => {
    const f = fixture();
    writeFileSync(join(f.checkout, f.pack, "local.md"), "Preserved authored improvement\n"); commit(f.checkout, "local improvement");
    writeFileSync(join(f.upstream, f.pack, "upstream.md"), "Revision B\n"); commit(f.upstream, "B");
    const before = inspectGitContext(f.target);
    expect(before.checkout).toMatchObject({ ahead: 1, behind: 0, selectedRevisionMatches: false }); // cached remote, no implicit fetch
    expect(readFileSync(join(f.target, "upstream.md"), "utf8")).toBe(f.original);
    const result = updateGitContext(f.target);
    expect(result.checkout).toMatchObject({ status: "", ahead: 2, behind: 0, selectedRevisionMatches: true });
    const upstream = readFileSync(join(f.target, "upstream.md"), "utf8");
    const local = readFileSync(join(f.target, "local.md"), "utf8");
    expect(upstream).toMatch(/^Revision B\r?\n$/);
    expect(local).toMatch(/^Preserved authored improvement\r?\n$/);
    expect(upstream).toBe(readFileSync(join(f.checkout, f.pack, "upstream.md"), "utf8"));
    expect(local).toBe(readFileSync(join(f.checkout, f.pack, "local.md"), "utf8"));
    expect(git(f.checkout, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
    expect(readdirSync(f.root)).toEqual(["guide"]); // no staging/history becomes another discoverable authority
    expect(readdirSync(`${f.root}-git-history`).some((name) => name.startsWith("previous-"))).toBe(true);
    expect(result.consumption).toContain("UNVERIFIED");
  });

  it("stops on a real merge conflict while keeping the old served bytes and both Git parents", () => {
    const f = fixture();
    writeFileSync(join(f.checkout, f.pack, "upstream.md"), "Local choice\n"); commit(f.checkout, "local");
    const local = git(f.checkout, "rev-parse", "HEAD");
    writeFileSync(join(f.upstream, f.pack, "upstream.md"), "Remote choice\n"); commit(f.upstream, "remote");
    const remote = git(f.upstream, "rev-parse", "HEAD");
    expect(() => updateGitContext(f.target)).toThrow(/merge failed/);
    expect(git(f.checkout, "rev-parse", "HEAD")).toBe(local);
    expect(git(f.checkout, "rev-parse", "MERGE_HEAD")).toBe(remote);
    expect(readFileSync(join(f.target, "upstream.md"), "utf8")).toBe(f.original);
    expect(inspectGitContext(f.target).checkout).toMatchObject({ conflicts: `${f.pack}/upstream.md`, ahead: 1, behind: 1 });
    expect(() => updateGitContext(f.target)).toThrow(/local changes or conflicts/);
  });

  it("refuses dirty checkout and edited served bytes without overwriting either", () => {
    const f = fixture();
    writeFileSync(join(f.checkout, f.pack, "local.md"), "Uncommitted improvement\n");
    expect(() => updateGitContext(f.target)).toThrow(/local changes/);
    expect(git(f.checkout, "rev-parse", "HEAD")).toBe(f.a);
    writeFileSync(join(f.target, "local.md"), "Direct served improvement\n");
    expect(inspectGitContext(f.target).served.edited).toBe(true);
    expect(() => updateGitContext(f.target)).toThrow(/Served context has local edits/);
    expect(readFileSync(join(f.target, "local.md"), "utf8")).toBe("Direct served improvement\n");
  });

  it("retains selected bytes on unavailable remote and exposes an unavailable checkout", () => {
    const f = fixture();
    renameSync(f.upstream, `${f.upstream}-offline`);
    expect(() => updateGitContext(f.target)).toThrow(/fetch failed/);
    expect(readFileSync(join(f.target, "upstream.md"), "utf8")).toBe(f.original);
    renameSync(f.checkout, `${f.checkout}-offline`);
    expect(inspectGitContext(f.target).checkout).toHaveProperty("unavailable");
  });

  it("reports ambiguous repository discovery and permits an explicit pack without copying unrelated data", () => {
    const f = fixture();
    mkdirSync(join(f.upstream, ".openrig/context-packs/other"));
    writeFileSync(join(f.upstream, ".openrig/context-packs/other/manifest.yaml"), "name: other\nversion: 1\ntaxonomy: world\nfiles: []\n");
    writeFileSync(join(f.upstream, "private-unrelated.txt"), "must stay in checkout"); commit(f.upstream, "other");
    expect(() => addGitContext(f.upstream, {}, join(f.home, "second"))).toThrow(/Discovered 2/);
    const result = addGitContext(f.upstream, { pack: f.pack, name: "namespaced/guide" }, join(f.home, "third"));
    expect(existsSync(join(result.installedAt, "private-unrelated.txt"))).toBe(false);
  });

  it("rejects escaped pack paths, symlinks and unsafe destination refs", () => {
    const f = fixture();
    expect(() => addGitContext(f.checkout, { checkout: true, pack: "../outside", name: "escape" }, f.root)).toThrow(/relative/);
    expect(() => addGitContext(f.checkout, { checkout: true, name: "../escape" }, f.root)).toThrow(/unsafe/);
    symlinkSync(f.home, join(f.checkout, f.pack, "escape"), process.platform === "win32" ? "junction" : "dir");
    expect(() => addGitContext(f.checkout, { checkout: true, name: "escape" }, f.root)).toThrow(/symlink/);
    expect(existsSync(join(f.root, "escape"))).toBe(false);
  });

  it("refuses a detached checkout for update and preserves an explicit selection", () => {
    const f = fixture(); git(f.checkout, "checkout", "--detach", "HEAD");
    expect(inspectGitContext(f.target).checkout).toMatchObject({ branch: null, upstream: null });
    expect(() => updateGitContext(f.target)).toThrow(/symbolic-ref failed/);
    expect(readFileSync(join(f.target, "upstream.md"), "utf8")).toBe(f.original);
  });
});
