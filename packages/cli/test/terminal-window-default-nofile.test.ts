import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultWindowDeps } from "../src/terminal-window.js";

const calls = vi.hoisted(() => [] as Array<{ file: string; args: string[] }>);
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFile = Object.assign(vi.fn(), {
    [promisify.custom]: async (file: string, args: string[]) => {
      calls.push({ file, args });
      return { stdout: "fixture output", stderr: "" };
    },
  });
  return { ...actual, execFile };
});
afterEach(() => { calls.length = 0; });

describe.skipIf(process.platform === "win32")("default window execution with a resolved tmux", () => {
  it("raises the creating child's limit and preserves the absolute executable and literal argv", async () => {
    const binary = "/fixture binaries/tmux";
    const args = ["-S", "/socket with spaces", "new-session", "-d", "-s", "viewer ' $HOME ;"];
    await expect(defaultWindowDeps().exec(binary, args)).resolves.toBe("fixture output");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("/bin/sh");
    expect(calls[0]!.args[1]).toContain("ulimit -S -n");
    expect(calls[0]!.args.slice(2)).toEqual([binary, ...args]);
  });

  it("keeps a non-creating capture on that executable direct", async () => {
    const args = ["capture-pane", "-p", "-t", "%1"];
    await defaultWindowDeps().exec("/fixture binaries/tmux", args);
    expect(calls).toEqual([{ file: "/fixture binaries/tmux", args }]);
  });

  it("does not wrap another executable whose data names a tmux startup verb", async () => {
    const args = ["new-session"];
    await defaultWindowDeps().exec("/fixture binaries/other", args);
    expect(calls).toEqual([{ file: "/fixture binaries/other", args }]);
  });
});
