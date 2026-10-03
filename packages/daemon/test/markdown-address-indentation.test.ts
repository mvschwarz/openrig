import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveAddress, parseMarkdownSections } from "../src/domain/markdown-address.js";
let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
it.each([1, 2, 3])("resolves valid %s-space headings and bounds context at the next sibling", (spaces) => {
  root = mkdtempSync(join(tmpdir(), "openrig-md-indent-"));
  const prefix = " ".repeat(spaces);
  const path = join(root, "context.md");
  writeFileSync(path, `## Selected\nkeep this\n${prefix}### Child\nchild text\n${prefix}## Excluded\nother context\n`);
  const text = readFileSync(path, "utf-8");
  expect.soft(resolveAddress(text, ["selected"]).text).not.toContain("other context");
  expect(resolveAddress(text, ["selected", "child"]).ownText).toContain("child text");
  expect(resolveAddress(text, ["excluded"]).text).toContain("other context");
});
it("retains indented code and fenced examples without turning them into addresses", () => {
  const text = "## Selected\n\n    ## Code example\n\n   ```md\n  ## Fenced example\n   ```\n\n## Sibling\n";
  expect(parseMarkdownSections(text).map((section) => section.headerPath)).toEqual([["selected"], ["sibling"]]);
  expect(resolveAddress(text, ["selected"]).text).toContain("## Code example");
  expect(resolveAddress(text, ["selected"]).text).toContain("## Fenced example");
});
