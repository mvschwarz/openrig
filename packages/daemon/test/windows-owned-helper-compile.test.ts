import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixture = vi.hoisted(() => ({ root: "", outputs: [] as string[], timeout: false }));
vi.mock("../src/domain/private-text-file.js", async original => {
  const actual = await original<typeof import("../src/domain/private-text-file.js")>();
  const create = () => fs.mkdtempSync(path.join(fixture.root, "stage-"));
  return { ...actual, createWindowsPrivateDirectory: create, createWindowsPrivateDirectoryAsync: async () => create() };
});
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  const fail = (output: string) => {
    fixture.outputs.push(output); fs.writeFileSync(output, "owned partial compiler output");
    return Object.assign(new Error("owned compiler failed"), fixture.timeout
      ? { code: "ETIMEDOUT", killed: true, signal: "SIGTERM" }
      : { code: 1, status: 1, signal: null });
  };
  return { ...actual,
    execFileSync: (_file: unknown, _args: unknown, options: { env: NodeJS.ProcessEnv }) => { throw fail(options.env.OPENRIG_OWNED_TEXT_HELPER!); },
    execFile: (_file: unknown, _args: unknown, options: { env: NodeJS.ProcessEnv }, callback: (error: Error) => void) => {
      const error = fail(options.env.OPENRIG_OWNED_TEXT_HELPER!);
      queueMicrotask(() => callback(error));
      return { stdin: { end() {} } };
    },
  };
});

beforeEach(() => {
  vi.resetModules(); fixture.outputs = []; fixture.timeout = false;
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-helper-compile-fixture-"));
});
afterEach(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

it.each(["sync", "async"] as const)("retires only owned staging after a confirmed %s compiler failure", async kind => {
  const helper = await import("../src/domain/windows-owned-text.js");
  if (kind === "sync") expect(() => helper.writeWindowsOwnedText(path.join(fixture.root, "unused"), "owned")).toThrow("owned compiler failed");
  else await expect(helper.assessWindowsFilePermissions(-1)).rejects.toThrow("owned compiler failed");
  expect(fixture.outputs).toHaveLength(1);
  expect(fs.existsSync(path.dirname(fixture.outputs[0]!))).toBe(false);
  expect(fs.readdirSync(fixture.root)).toEqual([]);
});

it.each(["sync", "async"] as const)("retains owned staging after an unconfirmed %s compiler timeout", async kind => {
  fixture.timeout = true;
  const helper = await import("../src/domain/windows-owned-text.js");
  if (kind === "sync") expect(() => helper.writeWindowsOwnedText(path.join(fixture.root, "unused"), "owned")).toThrow("owned compiler failed");
  else await expect(helper.assessWindowsFilePermissions(-1)).rejects.toThrow("owned compiler failed");
  expect(fixture.outputs).toHaveLength(1);
  expect(fs.readFileSync(fixture.outputs[0]!, "utf8")).toBe("owned partial compiler output");
});
