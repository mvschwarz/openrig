import { afterEach, expect, it } from "vitest";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWindowsPrivateDirectory, createWindowsPrivateDirectoryAsync, createPrivateTextFile, createPrivateTextFileAsync, openPrivateTextFile, replaceWindowsPrivateTextFile, replaceWindowsPrivateTextFileAsync } from "../src/domain/private-text-file.js";
import { assessWindowsFilePermissions } from "../src/domain/windows-owned-text.js";

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
it.runIf(process.platform === "win32")("publishes sync and async private replacements with a long destination basename", async () => {
  root = mkdtempSync(join(tmpdir(), "openrig-private-name-"));
  const file = join(root, `${"p".repeat(240)}.json`);
  replaceWindowsPrivateTextFile(file, "synthetic first");
  expect(readFileSync(file, "utf8")).toBe("synthetic first");
  await replaceWindowsPrivateTextFileAsync(file, "synthetic second");
  expect(readFileSync(file, "utf8")).toBe("synthetic second");
  replaceWindowsPrivateTextFile(file, "synthetic third");
  expect(readFileSync(file, "utf8")).toBe("synthetic third");
  const fd = openSync(file, "r");
  try { expect(await assessWindowsFilePermissions(fd)).toEqual({ owned: true, privateAcl: true }); }
  finally { closeSync(fd); }
  expect(readdirSync(root)).toEqual([file.split(/[\\/]/).at(-1)!]);
});
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
