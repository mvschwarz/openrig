import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitFrontmatter, updateFrontmatter } from "../src/lib/scope/scope-fs.js";

it("updates the actual field past a YAML key whose spelling starts with ---", () => {
  const root = mkdtempSync(join(tmpdir(), "openrig-fm-delimiter-"));
  const file = join(root, "SPEC.md");
  try {
    writeFileSync(file, "---\ntitle: keep\n---marker: keep too\nstage: wip\n---\n# Contract\n");
    updateFrontmatter(file, { stage: "provisional" });
    const updated = readFileSync(file, "utf8");
    expect(updated).toBe("---\ntitle: keep\n---marker: keep too\nstage: provisional\n---\n# Contract\n");
    expect(splitFrontmatter(updated).frontmatter.stage).toBe("provisional");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each(["\n", "\r\n"])("preserves delimiter whitespace while replacing the field (%j)", (newline) => {
  const root = mkdtempSync(join(tmpdir(), "openrig-fm-whitespace-"));
  const file = join(root, "SPEC.md");
  try {
    const source = ["--- \t", "stage: wip", "--- \t", "# Contract", ""].join(newline);
    writeFileSync(file, source);
    updateFrontmatter(file, { stage: "provisional" });
    expect(readFileSync(file, "utf8")).toBe(source.replace("stage: wip", "stage: provisional"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
