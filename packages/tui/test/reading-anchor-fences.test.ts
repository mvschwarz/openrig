import { describe, expect, it } from "vitest";
import { fileLines, type FileRead } from "../src/reading.js";

function shownFrom(content: string, anchor: string) {
  const read: FileRead = { root: "project", path: "guide.md", absolutePath: "/fixture/guide.md", content,
    mtime: "2026-10-10T00:00:00Z", contentHash: "fixture", size: content.length, totalBytes: content.length,
    truncated: false, truncatedAtBytes: null };
  return fileLines(read, { root: "project", path: "guide.md", anchor }, 100).map((line) => line.text).join("\n");
}

describe("file heading anchors inside fenced examples", () => {
  it.each(["```", "~~~~"]) ("keeps %s inside a four-backtick example", (inner) => {
    const content = ["````markdown", inner, "# Target", inner, "````", "# Target", "actual heading"].join("\n");
    expect(shownFrom(content, "target")).toContain("Showing from #target · source line 6");
  });
  it("ignores a matching marker followed by non-whitespace until a legal closing fence", () => {
    const content = ["~~~markdown", "~~~example", "# Target", "~~~", "# Target"].join("\n");
    expect(shownFrom(content, "target")).toContain("Showing from #target · source line 5");
  });
});
