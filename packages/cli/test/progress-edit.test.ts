// OPR.0.4.0.33 — pure markdown progress-edit helpers. These back the
// `rig scope ... progress` update verb. They must edit surgically:
// preserve the `# H1` title source + YAML frontmatter byte-for-byte,
// touch only the targeted section/row, and write the UI-valid shape
// (`- [ ]` / `- [x]` / `- [~]`) that progress-indexer.ts parses.

import { describe, expect, it } from "vitest";

import {
  addProgressRow,
  setProgressRow,
  statusIndicator,
} from "../src/lib/scope/progress-edit.js";
import { ScopeCliError } from "../src/lib/scope/types.js";

const SCAFFOLD = `---
id: OPR.0.4.0.1
stage: wip
verified: 2026-06-20 against scaffold
---
# Progress — Example Slice

## Acceptance

- [ ] Implementation complete
- [ ] Tests passing

## Notes

_Add progress notes here._
`;

describe("statusIndicator", () => {
  it("maps the three status words to indexer indicators", () => {
    expect(statusIndicator("active")).toBe(" ");
    expect(statusIndicator("done")).toBe("x");
    expect(statusIndicator("blocked")).toBe("~");
  });
});

describe("addProgressRow", () => {
  it("appends a row under an existing section in UI-valid shape", () => {
    const { content, changed } = addProgressRow(SCAFFOLD, {
      section: "Acceptance",
      text: "Guard approved",
      status: "active",
    });
    expect(changed).toBe(true);
    // New row lands at the end of the Acceptance section, before ## Notes.
    expect(content).toMatch(/- \[ \] Tests passing\n- \[ \] Guard approved\n\n## Notes/);
    // Frontmatter + H1 untouched.
    expect(content.startsWith("---\nid: OPR.0.4.0.1\n")).toBe(true);
    expect(content).toContain("# Progress — Example Slice");
  });

  it("writes the done/blocked indicators from --status", () => {
    const done = addProgressRow(SCAFFOLD, { section: "Acceptance", text: "Shipped", status: "done" });
    expect(done.content).toContain("- [x] Shipped");
    const blocked = addProgressRow(SCAFFOLD, { section: "Acceptance", text: "Waiting on QA", status: "blocked" });
    expect(blocked.content).toContain("- [~] Waiting on QA");
  });

  it("creates the section (## Rail default) when absent, appended after the last section", () => {
    const { content } = addProgressRow(SCAFFOLD, { section: "Rail", text: "First rail item", status: "active" });
    expect(content).toMatch(/## Rail\n\n- \[ \] First rail item/);
    // Appended after the pre-existing trailing section, not before it.
    expect(content.indexOf("## Notes")).toBeLessThan(content.indexOf("## Rail"));
  });

  it("is idempotent: adding an identical (section, text, status) row is a no-op", () => {
    const once = addProgressRow(SCAFFOLD, { section: "Acceptance", text: "Implementation complete", status: "active" });
    expect(once.changed).toBe(false);
    expect(once.content).toBe(SCAFFOLD);
  });

  it("refuses to create a conflicting duplicate: same text, different status → error pointing at --set", () => {
    expect(() =>
      addProgressRow(SCAFFOLD, { section: "Acceptance", text: "Implementation complete", status: "done" }),
    ).toThrow(ScopeCliError);
  });

  it("never rewrites unrelated lines or the frontmatter", () => {
    const { content } = addProgressRow(SCAFFOLD, { section: "Acceptance", text: "New thing", status: "active" });
    expect(content).toContain("verified: 2026-06-20 against scaffold");
    expect(content).toContain("_Add progress notes here._");
  });
});

describe("setProgressRow", () => {
  it("rewrites only the matched row's indicator, preserving the rest", () => {
    const { content, changed } = setProgressRow(SCAFFOLD, { text: "Tests passing", status: "done" });
    expect(changed).toBe(true);
    expect(content).toContain("- [x] Tests passing");
    // The sibling row is untouched.
    expect(content).toContain("- [ ] Implementation complete");
  });

  it("blocked status writes the ~ indicator", () => {
    const { content } = setProgressRow(SCAFFOLD, { text: "Implementation complete", status: "blocked" });
    expect(content).toContain("- [~] Implementation complete");
  });

  it("is idempotent: setting a row to its current status is a no-op", () => {
    const { content, changed } = setProgressRow(SCAFFOLD, { text: "Implementation complete", status: "active" });
    expect(changed).toBe(false);
    expect(content).toBe(SCAFFOLD);
  });

  it("errors when no row matches the exact trimmed text", () => {
    expect(() => setProgressRow(SCAFFOLD, { text: "nonexistent row", status: "done" })).toThrow(/nonexistent row/);
  });

  it("errors when more than one row matches (ambiguous; v0 refuses)", () => {
    const dup = SCAFFOLD.replace("- [ ] Tests passing", "- [ ] Dupe\n- [ ] Dupe");
    expect(() => setProgressRow(dup, { text: "Dupe", status: "done" })).toThrow(ScopeCliError);
  });
});
