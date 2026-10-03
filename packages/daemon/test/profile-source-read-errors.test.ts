import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeProfileReadFile } from "../src/domain/context-packs/profile-source-resolver.js";
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "openrig-source-errors-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function read(ref: string) { return makeProfileReadFile({ packDir: root, roots: {} })(ref); }
it("reports a directory source as unreadable rather than a dangling symlink", () => {
  mkdirSync(join(root, "notes.md"));
  expect(() => read("notes.md")).toThrow(/is unreadable/);
  try { read("notes.md"); } catch (error) { expect(String(error)).not.toContain("DANGLING"); }
});
it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reports an unreadable regular source without claiming its target is missing", () => {
  writeFileSync(join(root, "notes.md"), "protected source"); chmodSync(join(root, "notes.md"), 0);
  expect(() => read("notes.md")).toThrow(/is unreadable/);
});
it.skipIf(process.platform === "win32")("reports a looping symlink as unreadable rather than absent target", () => {
  symlinkSync("notes.md", join(root, "notes.md"));
  expect(() => read("notes.md")).toThrow(/is unreadable/);
});
it.skipIf(process.platform === "win32")("keeps the precise dangling-link diagnosis for an absent target", () => {
  symlinkSync("missing.md", join(root, "notes.md"));
  expect(() => read("notes.md")).toThrow(/is a DANGLING symlink/);
});
