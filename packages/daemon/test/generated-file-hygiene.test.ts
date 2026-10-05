import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { mergeManagedBlock } from "../src/domain/managed-blocks.js";
import { excludeNewGeneratedFiles } from "../src/domain/generated-file-hygiene.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { ProjectionEntry } from "../src/domain/projection-planner.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? walk(path.join(dir, e.name)).map(p => path.join(e.name, p)) : [e.name]);
}
const fsOps = {
  exists: fs.existsSync, readFile: (p: string) => fs.readFileSync(p, "utf8"),
  writeFile: (p: string, s: string) => fs.writeFileSync(p, s),
  mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); },
  listFiles: walk, statMode: (p: string) => fs.statSync(p).mode, chmod: fs.chmodSync, copyFile: fs.copyFileSync,
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

describe("generated file Git hygiene", () => {
  let root: string;
  let repo: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "generated-file-hygiene-"));
    repo = path.join(root, "repo"); fs.mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "initial");
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
  function write(relative: string, content = "User file\n", base = repo): string {
    const file = path.join(base, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file;
  }
  const excludePath = (cwd: string) => git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude").trim();
  function entry(category: "guidance" | "plugin", absolutePath: string): ProjectionEntry {
    return { category, effectiveId: "openrig-core", sourceSpec: "base", sourcePath: root, resourcePath: "source",
      absolutePath, classification: "safe_projection", ...(category === "guidance" ? { mergeStrategy: "managed_block" as const } : { pluginType: "codex" as const }) };
  }
  async function project(entries: ProjectionEntry[], cwd = repo, runtime: "codex" | "claude" = "codex", local = false) {
    const adapter = runtime === "codex" ? new CodexRuntimeAdapter({ fsOps, tmux: {} as TmuxAdapter })
      : new ClaudeCodeAdapter({ fsOps, tmux: {} as TmuxAdapter });
    const result = await adapter.project({ entries, runtime: adapter.runtime, cwd, startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
      { cwd, ...(local ? { claudeManagedBlockFile: "CLAUDE.local.md" } : {}) } as NodeBinding);
    expect(result.failed).toEqual([]);
    return result;
  }

  it("warns about newly generated guidance without hiding it", async () => {
    const source = write("guidance.md", "Managed guidance", root);
    for (const [runtime, local] of [["codex", false], ["claude", false], ["claude", true]] as const) {
      const result = await project([entry("guidance", source)], repo, runtime, local);
      const file = runtime === "codex" ? "AGENTS.md" : local ? "CLAUDE.local.md" : "CLAUDE.md";
      expect(result.warnings).toEqual([expect.stringContaining(`untracked. If you do not want to commit it, add this line to ${excludePath(repo)}: /${file}`)]);
    }
    write("notes.md");
    git(repo, "add", ".");
    expect(git(repo, "diff", "--cached", "--name-only").trim().split("\n").sort()).toEqual(["AGENTS.md", "CLAUDE.local.md", "CLAUDE.md", "notes.md"].sort());
    for (const file of ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"]) expect(fs.readFileSync(path.join(repo, file), "utf8")).toContain("Managed guidance");
  });

  it("keeps only newly generated plugin files out of git add", async () => {
    write("source/.codex-plugin/plugin.json", '{"name":"core"}', root);
    write("source/scripts/a [literal]*?.sh", "echo core", root);
    const userPlugin = write(".codex/plugins/openrig-core/user.txt");
    write(".codex/user-file"); write(".codex/plugins/unselected/plugin.json");
    const selected = entry("plugin", path.join(root, "source"));
    await project([selected]);
    const first = fs.readFileSync(excludePath(repo));
    await project([selected]);
    expect(fs.readFileSync(excludePath(repo))).toEqual(first);
    expect(fs.readFileSync(userPlugin, "utf8")).toBe("User file\n");
    git(repo, "add", ".");
    expect(git(repo, "diff", "--cached", "--name-only").trim().split("\n").sort()).toEqual([
      ".codex/plugins/openrig-core/user.txt", ".codex/plugins/unselected/plugin.json", ".codex/user-file",
    ]);
  });

  it.each([false, true])("preserves pre-existing guidance and plugin visibility (tracked=%s)", async tracked => {
    const names = ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", ".codex/plugins/openrig-core/payload.txt"];
    names.forEach(name => write(name));
    if (tracked) { git(repo, "add", "."); git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "user files"); }
    const before = fs.readFileSync(excludePath(repo));
    const source = write("guidance.md", "Managed", root);
    for (const [runtime, local] of [["codex", false], ["claude", false], ["claude", true]] as const) await project([entry("guidance", source)], repo, runtime, local);
    write("source/payload.txt", "Updated plugin", root); await project([entry("plugin", path.join(root, "source"))]);
    expect(fs.readFileSync(excludePath(repo))).toEqual(before);
    for (const name of names.slice(0, 3)) expect(fs.readFileSync(path.join(repo, name), "utf8")).toContain("User file");
    const visible = git(repo, "status", "--porcelain", "-uall");
    for (const name of names) expect(visible).toContain(name);
  });

  it("preserves arbitrary exclude bytes and escapes exact paths from a subdirectory", () => {
    const original = Buffer.from([35, 255, 13, 10, ...Buffer.from("/custom\r\n# no final newline")]);
    fs.writeFileSync(excludePath(repo), original);
    const generated = write("sub/.codex/plugins/openrig-core/a [literal]*?!#.md");
    excludeNewGeneratedFiles(path.join(repo, "sub"), [generated]);
    const after = fs.readFileSync(excludePath(repo));
    expect(after.subarray(0, original.length)).toEqual(original);
    expect(git(repo, "check-ignore", "--", generated).trim()).toBe(generated);
    write("sub/.codex/plugins/openrig-core/a lOTHERx!#.md");
    expect(git(repo, "status", "--porcelain", "-uall")).toContain("sub/.codex/plugins/openrig-core/a lOTHERx!#.md");
    excludeNewGeneratedFiles(path.join(repo, "sub"), [generated]);
    expect(fs.readFileSync(excludePath(repo))).toEqual(after);
  });

  it("keeps later sibling user guidance visible (review F1)", () => {
    const linked = path.join(root, "linked"); git(repo, "worktree", "add", "-q", "-b", "linked", linked);
    expect(fs.statSync(path.join(linked, ".git")).isFile()).toBe(true);
    mergeManagedBlock(fsOps, path.join(repo, "AGENTS.md"), "core", "Managed");
    write("AGENTS.md", "Later user file", linked);
    git(linked, "add", "-A");
    expect(git(linked, "ls-files", "-z")).toBe("AGENTS.md\0");
  });

  it("keeps an existing case-variant sibling guidance visible (review F2)", () => {
    git(repo, "config", "core.ignorecase", "true");
    const linked = path.join(root, "linked"); git(repo, "worktree", "add", "-q", "-b", "linked", linked);
    write("agents.md", "User lower-case", linked);
    mergeManagedBlock(fsOps, path.join(repo, "AGENTS.md"), "core", "Managed");
    git(linked, "add", "-A");
    expect(git(linked, "ls-files", "-z")).toBe("agents.md\0");
  });

  it.each([false, true])("preserves current sibling plugin conflicts with Git case matching (ignorecase=%s)", ignoreCase => {
    git(repo, "config", "core.ignorecase", String(ignoreCase));
    const linked = path.join(root, "linked"); git(repo, "worktree", "add", "-q", "-b", "linked", linked);
    const name = ".codex/plugins/openrig-core/payload.txt";
    write(name, "User", linked);
    const generated = write(ignoreCase ? name.replace("payload", "PAYLOAD") : name);
    const warnings = excludeNewGeneratedFiles(repo, [generated]);
    expect(warnings).toEqual([expect.stringContaining("already exists in worktree")]);
    git(linked, "add", "-A");
    expect(git(linked, "ls-files", "-z")).toBe(name + "\0");
  });

  it("excludes core plugin files in bare-clone linked worktrees", () => {
    const bare = path.join(root, "bare.git"); git(root, "clone", "--bare", "-q", repo, bare);
    const linked = path.join(root, "linked"); git(bare, "worktree", "add", "-q", "-b", "linked", linked);
    const file = write(".codex/plugins/openrig-core/payload.txt", "Managed", linked);
    expect(excludeNewGeneratedFiles(linked, [file])).toEqual([]);
    expect(git(linked, "check-ignore", "--", file).trim()).toBe(file);
  });

  it("does not automatically exclude another plugin namespace", async () => {
    write("source/payload.txt", "Managed", root);
    const other = { ...entry("plugin", path.join(root, "source")), effectiveId: "other" };
    const result = await project([other]);
    expect(result.warnings?.join(" ")).toContain("untracked");
    git(repo, "add", "-A");
    expect(git(repo, "ls-files", "-z")).toBe(".codex/plugins/other/payload.txt\0");
  });

  it("leaves a recreated tracked path visible and supports non-Git workspaces", () => {
    const tracked = write("AGENTS.md"); git(repo, "add", "AGENTS.md");
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "tracked");
    fs.unlinkSync(tracked);
    mergeManagedBlock(fsOps, tracked, "core", "Managed");
    expect(fs.readFileSync(excludePath(repo), "utf8")).not.toContain("/AGENTS.md");
    expect(git(repo, "diff", "--name-only")).toContain("AGENTS.md");
    const plain = path.join(root, "plain/AGENTS.md");
    mergeManagedBlock(fsOps, plain, "core", "Managed");
    expect(fs.readFileSync(plain, "utf8")).toContain("Managed");
    expect(fs.existsSync(path.join(root, "plain/.git"))).toBe(false);
  });

  it("warns without refusing projection when a registered sibling cannot be inspected", () => {
    const linked = path.join(root, "unavailable"); git(repo, "worktree", "add", "-q", "-b", "unavailable", linked);
    fs.renameSync(linked, path.join(root, "moved"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = fs.readFileSync(excludePath(repo));
    const file = write(".codex/plugins/openrig-core/payload.txt", "Managed");
    const reasons = excludeNewGeneratedFiles(repo, [file]);
    expect(reasons.join(" ")).toContain("generated_file_exclude_skipped");
    expect(fs.readFileSync(file, "utf8")).toContain("Managed");
    expect(fs.readFileSync(excludePath(repo))).toEqual(before);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("generated_file_exclude_skipped"));
  });
  it("returns an append failure as a projection warning without failing the projection", async () => {
    fs.unlinkSync(excludePath(repo)); fs.mkdirSync(excludePath(repo));
    write("source/payload.txt", "Managed", root);
    const result = await project([entry("plugin", path.join(root, "source"))]);
    expect(result.projected).toEqual(["openrig-core"]);
    expect(result.warnings?.join(" ")).toContain("generated_file_exclude_skipped");
    expect(fs.readFileSync(path.join(repo, ".codex/plugins/openrig-core/payload.txt"), "utf8")).toBe("Managed");
  });

  it("batches index and metadata reads regardless of plugin file count", () => {
    const linked = path.join(root, "linked"); git(repo, "worktree", "add", "-q", "-b", "linked", linked);
    const files = Array.from({ length: 24 }, (_, i) => write(`.codex/plugins/openrig-core/file${i}`));
    const beforePath = process.env.PATH;
    const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const bin = path.join(root, "bin"), log = path.join(root, "git-calls"); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "git"), `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');
try { process.stdout.write(cp.execFileSync(${JSON.stringify(realGit)},process.argv.slice(2), {input:fs.readFileSync(0)})); }
catch(e) { process.stderr.write(e.stderr||''); process.exit(e.status||1); }
`, { mode: 0o755 });
    try {
      process.env.PATH = bin + path.delimiter + beforePath;
      expect(excludeNewGeneratedFiles(repo, files)).toEqual([]);
    } finally { process.env.PATH = beforePath; }
    const calls: string[][] = fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    for (const cwd of [repo, linked]) {
      expect(calls.filter(args => args[1] === cwd && args.includes("ls-files"))).toHaveLength(1);
      expect(calls.filter(args => args[1] === cwd && args.includes("info/exclude"))).toHaveLength(1);
    }
  });

  it.each(["current", "sibling"])("does not inventory a large ignored tree in the %s worktree", location => {
    const linked = path.join(root, "linked"); git(repo, "worktree", "add", "-q", "-b", "linked", linked);
    const target = location === "current" ? repo : linked;
    write(".gitignore", "/node_modules/\n", target);
    const dependencies = path.join(target, "node_modules"); fs.mkdirSync(dependencies);
    for (let i = 0; i < 10000; i++) fs.writeFileSync(path.join(dependencies, `${i}-${"x".repeat(210)}`), "");
    const unbounded = execFileSync("git", ["-C", target, "ls-files", "--cached", "--others", "-t", "-z"], { maxBuffer: 4 * 1024 * 1024 });
    expect(unbounded.length).toBeGreaterThan(2 * 1024 * 1024);
    const tracked = write("AGENTS.md"); git(repo, "add", "AGENTS.md");
    const generated = write(".codex/plugins/openrig-core/payload.txt");
    expect(excludeNewGeneratedFiles(repo, [generated, tracked])).toEqual([]);
    expect(git(repo, "check-ignore", "--", generated).trim()).toBe(generated);
    expect(git(repo, "ls-files", "--", "AGENTS.md").trim()).toBe("AGENTS.md");
  });

  it("matches case-variant plugin directories from a literal subdirectory", () => {
    git(repo, "config", "core.ignorecase", "true");
    const linked = path.join(root, "linked"); git(repo, "worktree", "add", "-q", "-b", "linked", linked);
    const userFile = "SUB [LITERAL]/.CODEX/PLUGINS/OPENRIG-CORE/PAYLOAD.TXT";
    write(userFile, "User", linked);
    const generated = write("sub [literal]/.codex/plugins/openrig-core/payload.txt");
    expect(excludeNewGeneratedFiles(path.join(repo, "sub [literal]"), [generated]))
      .toEqual([expect.stringContaining("already exists in worktree")]);
    git(linked, "add", "-A");
    expect(git(linked, "ls-files", "-z")).toBe(userFile + "\0");
  });

  it("uses one overall Git deadline and leaves excludes unchanged when it expires", () => {
    const beforePath = process.env.PATH;
    const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const bin = path.join(root, "slow-bin"); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "git"), `#!${process.execPath}
const cp = require('node:child_process');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1800);
try { process.stdout.write(cp.execFileSync(${JSON.stringify(realGit)},process.argv.slice(2), {input:require('node:fs').readFileSync(0)})); }
catch(e) { process.stderr.write(e.stderr||''); process.exit(e.status||1); }
`, { mode: 0o755 });
    const before = fs.readFileSync(excludePath(repo));
    const file = write(".codex/plugins/openrig-core/file");
    const start = performance.now();
    let warnings: string[] = [];
    try {
      process.env.PATH = bin + path.delimiter + beforePath;
      warnings = excludeNewGeneratedFiles(repo, [file]);
    } finally { process.env.PATH = beforePath; }
    expect(performance.now() - start).toBeLessThan(6500);
    expect(warnings.join(" ")).toContain("generated_file_exclude_skipped");
    expect(fs.readFileSync(excludePath(repo))).toEqual(before);
  }, 10000);

});
