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
