import { afterEach, expect, it } from "vitest";
import { closeSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWindowsPrivateDirectory, createWindowsPrivateDirectoryAsync, createPrivateTextFile, createPrivateTextFileAsync, openPrivateTextFile } from "../src/domain/private-text-file.js";

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
it.runIf(process.platform === "win32")("creates private output beneath a native long Unicode path", async () => {
  root = mkdtempSync(join(tmpdir(), "openrig-private-long-"));
  let parent = root;
  while (parent.length < 280) parent = join(parent, "用户-long-segment-0123456789");
  mkdirSync(parent, { recursive: true });
  const directory = createWindowsPrivateDirectory(parent);
  const asyncDirectory = await createWindowsPrivateDirectoryAsync(parent);
  const file = join(directory, "output.txt");
  createPrivateTextFile(file, "synthetic sync");
  expect(readFileSync(file, "utf8")).toBe("synthetic sync");
  const asyncFile = join(asyncDirectory, "output.txt");
  await createPrivateTextFileAsync(asyncFile, "synthetic async");
  expect(readFileSync(asyncFile, "utf8")).toBe("synthetic async");
  const exclusive = join(parent, "exclusive.txt");
  const fd = openPrivateTextFile(exclusive);
  try { writeFileSync(fd, "synthetic descriptor"); } finally { closeSync(fd); }
  expect(readFileSync(exclusive, "utf8")).toBe("synthetic descriptor");
  expect(readdirSync(parent).sort()).toEqual([directory.split(/[\\/]/).at(-1)!, asyncDirectory.split(/[\\/]/).at(-1)!, "exclusive.txt"].sort());
});
