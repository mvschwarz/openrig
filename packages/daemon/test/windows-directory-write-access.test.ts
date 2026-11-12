import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { checkWindowsDirectoryWriteAccess } from "../src/domain/windows-owned-text.js";
import { denyWindowsDirectoryCreation } from "./helpers/directory-permissions.js";

it.runIf(process.platform === "win32")("checks native directory create rights without changing its contents or mtime", () => {
  const root = mkdtempSync(join(tmpdir(), "native-dir-access-"));
  const file = join(root, "existing.txt"); writeFileSync(file, "synthetic");
  const restore = denyWindowsDirectoryCreation(root);
  utimesSync(root, new Date(946684800000), new Date(946684800000));
  const before = statSync(root).mtimeMs;
  try {
    expect(() => checkWindowsDirectoryWriteAccess(root)).toThrow();
    expect(statSync(root).mtimeMs).toBe(before);
    expect(readdirSync(root)).toEqual(["existing.txt"]);
    restore();
    expect(() => checkWindowsDirectoryWriteAccess(root)).not.toThrow();
    expect(statSync(root).mtimeMs).toBe(before);
    expect(readdirSync(root)).toEqual(["existing.txt"]);
    expect(() => checkWindowsDirectoryWriteAccess(file)).toThrow();
    expect(() => checkWindowsDirectoryWriteAccess(join(root, "missing"))).toThrow();
  } finally { restore(); rmSync(root, { recursive: true, force: true }); }
});
