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
    return { category, effectiveId: "core", sourceSpec: "base", sourcePath: root, resourcePath: "source",
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

  it("keeps newly generated guidance out of git add while preserving adjacent user files", async () => {
    const source = write("guidance.md", "Managed guidance", root);
    for (const [runtime, local] of [["codex", false], ["claude", false], ["claude", true]] as const) {
      await project([entry("guidance", source)], repo, runtime, local);
    }
    write("notes.md");
    git(repo, "add", ".");
    expect(git(repo, "diff", "--cached", "--name-only").trim()).toBe("notes.md");
    for (const file of ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"]) expect(fs.readFileSync(path.join(repo, file), "utf8")).toContain("Managed guidance");
  });

  it("keeps only newly generated plugin files out of git add", async () => {
    write("source/.codex-plugin/plugin.json", '{"name":"core"}', root);
    write("source/scripts/a [literal]*?.sh", "echo core", root);
    const userPlugin = write(".codex/plugins/core/user.txt");
    write(".codex/user-file"); write(".codex/plugins/unselected/plugin.json");
    const selected = entry("plugin", path.join(root, "source"));
    await project([selected]);
    const first = fs.readFileSync(excludePath(repo));
    await project([selected]);
    expect(fs.readFileSync(excludePath(repo))).toEqual(first);
    expect(fs.readFileSync(userPlugin, "utf8")).toBe("User file\n");
    git(repo, "add", ".");
    expect(git(repo, "diff", "--cached", "--name-only").trim().split("\n").sort()).toEqual([
      ".codex/plugins/core/user.txt", ".codex/plugins/unselected/plugin.json", ".codex/user-file",
    ]);
  });

  it.each([false, true])("preserves pre-existing guidance and plugin visibility (tracked=%s)", async tracked => {
    const names = ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md", ".codex/plugins/core/payload.txt"];
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
    const generated = write("sub/a [literal]*?!#.md");
    excludeNewGeneratedFiles(path.dirname(generated), [generated]);
    const after = fs.readFileSync(excludePath(repo));
    expect(after.subarray(0, original.length)).toEqual(original);
    expect(git(repo, "check-ignore", "--", generated).trim()).toBe(generated);
    write("sub/a lOTHERx!#.md");
    expect(git(repo, "status", "--porcelain", "-uall")).toContain("sub/a lOTHERx!#.md");
    excludeNewGeneratedFiles(repo, [generated]);
    expect(fs.readFileSync(excludePath(repo))).toEqual(after);
  });

  it("resolves linked Git metadata and refuses a shared exclusion that hides a sibling user file", () => {
    const linked = path.join(root, "linked"); git(repo, "worktree", "add", "-q", "-b", "linked", linked);
    expect(fs.statSync(path.join(linked, ".git")).isFile()).toBe(true);
    write("AGENTS.md");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    mergeManagedBlock(fsOps, path.join(linked, "AGENTS.md"), "core", "Managed");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("sibling worktree"));
    expect(git(repo, "status", "--porcelain", "-uall")).toContain("AGENTS.md");
    expect(git(linked, "status", "--porcelain", "-uall")).toContain("AGENTS.md");
    mergeManagedBlock(fsOps, path.join(linked, "CLAUDE.local.md"), "core", "Managed");
    expect(git(linked, "status", "--porcelain", "-uall")).not.toContain("CLAUDE.local.md");
    expect(fs.readFileSync(excludePath(repo), "utf8")).toContain("/CLAUDE.local.md");
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
    mergeManagedBlock(fsOps, path.join(repo, "AGENTS.md"), "core", "Managed");
    expect(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8")).toContain("Managed");
    expect(fs.readFileSync(excludePath(repo))).toEqual(before);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("generated_file_exclude_skipped"));
  });
});
