import { expect, it } from "vitest";
import { fileLines, fileTargetForPath, type FileRead } from "../src/reading.js";

it.each(["C:\\work\\project\\docs\\chapter.md", "\\\\host\\share\\project\\docs\\chapter.md"])("resolves links from a Windows reader's actual source: %s", (absolutePath) => {
  const result: FileRead = {
    root: "project", path: "alias.md", absolutePath, resolvedPath: "docs\\chapter.md",
    content: "[Back to outline](../outline.md)", mtime: "", contentHash: "",
    size: 0, truncated: false, truncatedAtBytes: null, totalBytes: 0,
  };
  const link = fileLines(result, { root: "project", path: "alias.md" }, 100)
    .find((line) => line.text.includes("Back to outline") && line.action)?.action;
  expect(link).toEqual({ type: "file-open", target: { root: "project", path: "outline.md" } });
});

it("maps served Windows sources including mixed separators and UNC shares from any TUI host", () => {
  const roots = [{ name: "project", path: "C:\\work\\project" }, { name: "docs", path: "C:/work/project/docs" }];
  expect(fileTargetForPath("c:\\work\\project\\docs\\中文 space.md", roots)).toEqual({ root: "docs", path: "中文 space.md" });
  expect(fileTargetForPath("C:/work/project/story.yaml", roots)).toEqual({ root: "project", path: "story.yaml" });
  expect(fileTargetForPath("\\\\host\\share\\project\\story.yaml", [{ name: "share", path: "\\\\host\\share\\project" }])).toEqual({ root: "share", path: "story.yaml" });
  for (const source of ["C:/work/project-other/secret", "C:/work/project/../secret", "D:/work/project/story.yaml", "story.yaml"]) expect(fileTargetForPath(source, roots)).toBeNull();
});

it("retains POSIX case and root boundaries when the daemon is remote", () => {
  const roots = [{ name: "remote", path: "/work/Project" }];
  expect(fileTargetForPath("/work/Project/docs/story.md", roots)).toEqual({ root: "remote", path: "docs/story.md" });
  expect(fileTargetForPath("/work/project/docs/story.md", roots)).toBeNull();
  expect(fileTargetForPath("/work/Project/../secret", roots)).toBeNull();
});
