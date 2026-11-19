import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncOwnedFilesystemPath } from "../src/domain/filesystem-sync.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openrig-flush-")); roots.push(root);
  const file = join(root, "retained history.jsonl"); writeFileSync(file, "retained bytes\n");
  return { root, file };
}
it("flushes an owned file and its publication directory without changing retained bytes", () => {
  const { root, file } = fixture();
  syncOwnedFilesystemPath(file);
  syncOwnedFilesystemPath(root, true);
  expect(readFileSync(file, "utf8")).toBe("retained bytes\n");
});
it("propagates missing-path errors instead of claiming durability", () => {
  const { root } = fixture();
  expect(() => syncOwnedFilesystemPath(join(root, "missing"))).toThrow();
});
it.skipIf(process.platform !== "win32")("rejects a substituted junction and incorrect handle types", () => {
  const { root, file } = fixture();
  const junction = join(root, "redirect"); symlinkSync(root, junction, "junction");
  expect(() => syncOwnedFilesystemPath(junction, true)).toThrow();
  expect(() => syncOwnedFilesystemPath(root)).toThrow();
  expect(() => syncOwnedFilesystemPath(file, true)).toThrow();
});
