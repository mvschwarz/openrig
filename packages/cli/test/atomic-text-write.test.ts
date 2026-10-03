import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeTextAtomically } from "../src/atomic-text-write.js";

const failure = vi.hoisted(() => ({ active: false }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (failure.active) {
      failure.active = false;
      actual.writeFileSync(args[0], "partial YAML");
      throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
    }
    return actual.writeFileSync(...args);
  } };
});
let dir: string | undefined;
afterEach(() => { failure.active = false; if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
it("preserves an existing export and removes staging after a partial failed write", () => {
  dir = fs.mkdtempSync(join(tmpdir(), "export-atomic-"));
  const target = join(dir, "rig.yaml");
  fs.writeFileSync(target, "name: original\n");
  failure.active = true;
  expect(() => writeTextAtomically(target, "name: replacement\n", "export")).toThrow(/no space left/);
  expect(fs.readFileSync(target, "utf8")).toBe("name: original\n");
  expect(fs.readdirSync(dir)).toEqual(["rig.yaml"]);
});
it("retains export symlinks and target permissions on successful replacement", () => {
  dir = fs.mkdtempSync(join(tmpdir(), "export-atomic-"));
  const target = join(dir, "saved.yaml"), link = join(dir, "rig.yaml");
  fs.writeFileSync(target, "name: original\n"); fs.chmodSync(target, 0o640); fs.symlinkSync(target, link);
  writeTextAtomically(link, "name: replacement\n", "export");
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(target, "utf8")).toBe("name: replacement\n");
  if (process.platform !== "win32") expect(fs.statSync(target).mode & 0o777).toBe(0o640);
  expect(fs.readdirSync(dir).sort()).toEqual(["rig.yaml", "saved.yaml"]);
});
it.skipIf(process.platform === "win32")("keeps staging names within native filename limits", () => {
  dir = fs.mkdtempSync(join(tmpdir(), "export-atomic-"));
  const name = "r".repeat(250) + ".yaml";
  const target = join(dir, name);
  fs.writeFileSync(target, "name: original\n");
  writeTextAtomically(target, "name: replacement\n", "export");
  expect(fs.readFileSync(target, "utf8")).toBe("name: replacement\n");
  expect(fs.readdirSync(dir)).toEqual([name]);
});
it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("overwrites a native write-only export without requiring read access", () => {
  dir = fs.mkdtempSync(join(tmpdir(), "export-atomic-"));
  const target = join(dir, "rig.yaml");
  fs.writeFileSync(target, "name: original\n"); fs.chmodSync(target, 0o200);
  writeTextAtomically(target, "name: replacement\n", "export");
  expect(fs.statSync(target).mode & 0o777).toBe(0o200);
  fs.chmodSync(target, 0o600);
  expect(fs.readFileSync(target, "utf8")).toBe("name: replacement\n");
});
