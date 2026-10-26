import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { helperCwd } from "../src/helper-cwd.js";

vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

afterEach(() => vi.restoreAllMocks());

it("uses home when a cached cwd path has a non-directory component", () => {
  // Model the stat result without changing the test runner's cwd or its parent directory.
  vi.spyOn(fs, "statSync").mockImplementationOnce(() => {
    throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
  });
  expect(helperCwd()).toBe(homedir());
});

it("inherits cwd for other stat failures, so the existing child can still run", async () => {
  // Search permission on a parent may fail even though the current directory is still usable.
  vi.spyOn(fs, "statSync").mockImplementationOnce(() => {
    throw Object.assign(new Error("permission denied"), { code: "EACCES" });
  });
  const cwd = helperCwd();
  expect(cwd).toBeUndefined();
  const { stdout } = await promisify(execFile)(process.execPath,
    ["-e", "process.stdout.write(process.cwd())"], { cwd, timeout: 5000 });
  expect(stdout).toBe(process.cwd());
});
