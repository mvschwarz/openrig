import { expect, it } from "vitest";
import path from "node:path";
import { validateSafePath } from "../src/domain/path-safety.js";

it.each(["C:outside.md", "d:folder/file.md", "Z:", "C:../outside", "a:.\\file"])("rejects drive-relative authored path %s", value => {
  expect(validateSafePath(value, "fixture")).toContain("drive-relative paths are not allowed");
});
it("does not treat another drive's relative spelling as relative to a bundle", () => {
  const resolved = path.win32.resolve("C:\\owned-bundle", "D:outside.md");
  expect(path.win32.isAbsolute(path.win32.relative("C:\\owned-bundle", resolved))).toBe(true);
  expect(validateSafePath("D:outside.md", "fixture")).not.toBeNull();
});
it.each(["file\0.md", "folder/\0file"])("rejects NUL in %j before filesystem calls", value => {
  expect(validateSafePath(value, "fixture")).toBe("fixture: NUL characters are not allowed");
});
it.each(["C:/outside", "C:\\outside", "/outside", "\\\\host\\share\\file", "\\\\?\\C:\\file", "..\\file", "folder/../file"])("retains existing absolute/traversal refusal for %s", value => {
  expect(validateSafePath(value, "fixture")).not.toBeNull();
});
it.each(["folder/file.md", "folder\\file.md", "file with spaces.md", "\u4e2d\u6587/notes.md", "..notes/file", "folder/notes:v2.md"])("retains ordinary relative spelling %s", value => {
  expect(validateSafePath(value, "fixture")).toBeNull();
});
