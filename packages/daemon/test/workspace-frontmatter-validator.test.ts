// PL-007 Workspace Primitive v0 — frontmatter validator tests.
//
// Pins:
//   - missing-required-field per kind for knowledge canon
//   - unrecognized-status-value when status is not in the allowed enum
//   - parse-error when frontmatter is malformed YAML
//   - clean canon (every field present + status valid) returns 0 gaps
//   - non-recursive scope walks only top-level
//   - skips noise dirs (node_modules / .git)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateWorkspaceFrontmatter } from "../src/domain/workspace/frontmatter-validator.js";

let dir: string;

function write(rel: string, contents: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents, "utf-8");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pl007-fmv-"));
});

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("validateWorkspaceFrontmatter (PL-007)", () => {
  it("clean knowledge canon: 0 gaps", () => {
    write("alpha.md", "---\ndoc: alpha\nstatus: active\ncreated: 2026-05-04\nowner: someone\n---\n# Alpha\n");
    write("beta.md",  "---\ndoc: beta\nstatus: draft\ncreated: 2026-05-04\nowner: someone\n---\n# Beta\n");
    const r = validateWorkspaceFrontmatter({ root: dir, workspaceKind: "knowledge" });
    expect(r.totalFiles).toBe(2);
    expect(r.filesWithFrontmatter).toBe(2);
    expect(r.gapCount).toBe(0);
  });

  it("missing-required-field for knowledge canon (no owner)", () => {
    write("alpha.md", "---\ndoc: alpha\nstatus: active\ncreated: 2026-05-04\n---\n# alpha\n");
    const r = validateWorkspaceFrontmatter({ root: dir, workspaceKind: "knowledge" });
    expect(r.gapCount).toBe(1);
    expect(r.gaps[0]?.kind).toBe("missing-required-field");
    expect(r.gaps[0]?.field).toBe("owner");
  });

  it("unrecognized-status-value when status is invalid", () => {
    write("a.md", "---\ndoc: a\nstatus: in-flight\ncreated: 2026-05-04\nowner: x\n---\n");
    const r = validateWorkspaceFrontmatter({ root: dir, workspaceKind: "knowledge" });
    expect(r.gaps.some((g) => g.kind === "unrecognized-status-value")).toBe(true);
  });

  it("parse-error when frontmatter YAML is malformed", () => {
    write("a.md", "---\nthis: is\n  bad: ye:s::\n---\n");
    const r = validateWorkspaceFrontmatter({ root: dir, workspaceKind: "knowledge" });
    expect(r.gaps.some((g) => g.kind === "parse-error")).toBe(true);
  });

  it("user kind has lighter required set", () => {
    write("a.md", "---\ndoc: u\n---\n# u\n");
    const r = validateWorkspaceFrontmatter({ root: dir, workspaceKind: "user" });
    expect(r.gapCount).toBe(0);
  });

  it("missing-frontmatter is silent by default; reported when requireFrontmatter=true", () => {
    write("a.md", "# alpha\nplain markdown, no fm\n");
    const def = validateWorkspaceFrontmatter({ root: dir, workspaceKind: "knowledge" });
    expect(def.gapCount).toBe(0);
    const strict = validateWorkspaceFrontmatter({ root: dir, workspaceKind: "knowledge", requireFrontmatter: true });
    expect(strict.gaps.some((g) => g.kind === "missing-frontmatter")).toBe(true);
  });

  it("skips node_modules and .git noise dirs", () => {
    write("node_modules/a.md", "---\ndoc: a\n---\n");
    write(".git/b.md", "---\ndoc: b\n---\n");
    write("real.md", "---\ndoc: real\nstatus: active\ncreated: 2026-05-04\nowner: x\n---\n");
    const r = validateWorkspaceFrontmatter({ root: dir, workspaceKind: "knowledge" });
    expect(r.totalFiles).toBe(1);
  });

  it("non-recursive walks only top-level", () => {
    write("a.md", "---\ndoc: a\n---\n");
    write("nested/b.md", "---\ndoc: b\n---\n");
    const r = validateWorkspaceFrontmatter({ root: dir, recursive: false });
    expect(r.totalFiles).toBe(1);
  });

  it("never modifies any input file (advisory contract)", () => {
    const content = "---\ndoc: a\nstatus: rotten\n---\nbody\n";
    write("a.md", content);
    validateWorkspaceFrontmatter({ root: dir, workspaceKind: "knowledge" });
    expect(fs.readFileSync(path.join(dir, "a.md"), "utf-8")).toBe(content);
  });
});


describe("malformed frontmatter structure", () => {
  it.each(["\n", "\r\n"])("reports an unclosed block with %j line endings even in optional mode", (newline) => {
    const content = ["---", "doc: alpha", "status: active", "created: 2026-05-04", "owner: someone", ""].join(newline);
    write("broken.md", content);
    for (const requireFrontmatter of [false, true]) {
      const report = validateWorkspaceFrontmatter({ root: dir, requireFrontmatter });
      expect(report.filesWithFrontmatter).toBe(1);
      expect(report.gaps).toMatchObject([{ relativePath: "broken.md", kind: "parse-error", field: null }]);
      expect(report.gapCount).toBe(1);
    }
    expect(fs.readFileSync(path.join(dir, "broken.md"), "utf8")).toBe(content);
  });

  it.each(["[]", "- doc: alpha", "- alpha\n- beta"])("reports a YAML sequence as a parse error: %s", (body) => {
    write("array.md", `---\n${body}\n---\n`);
    for (const workspaceKind of [undefined, "knowledge"] as const) {
      const report = validateWorkspaceFrontmatter({ root: dir, workspaceKind });
      expect(report.filesWithFrontmatter).toBe(1);
      expect(report.gaps).toMatchObject([{ kind: "parse-error", field: null }]);
      expect(report.gapCount).toBe(1);
    }
  });

  it("keeps a closing delimiter at EOF valid and skips ordinary Markdown", () => {
    write("valid.md", "---\ndoc: alpha\n---");
    write("plain.md", "# Notes\n---\nA horizontal rule.\n");
    write("prefix.md", "----\nNot a frontmatter opener.\n");
    const report = validateWorkspaceFrontmatter({ root: dir, workspaceKind: "project" });
    expect(report).toMatchObject({ totalFiles: 3, filesWithFrontmatter: 1, gapCount: 0 });
  });
});
