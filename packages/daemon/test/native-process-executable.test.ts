import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { execute, readlink } = vi.hoisted(() => ({ execute: vi.fn(), readlink: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: execute }) }));
vi.mock("node:fs/promises", () => ({ readlink }));
import { readNativeExecutablePaths } from "../src/domain/native-process-executable.js";
const platform = process.platform;
const setPlatform = (value: string) => Object.defineProperty(process, "platform", { value, configurable: true });
beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { setPlatform(platform); });

describe("OS executable path witness", () => {
  it("reads Linux proc links, retaining successful PIDs when another exits", async () => {
    setPlatform("linux");
    readlink.mockResolvedValueOnce("/home/test/.local/share/claude/versions/2.1.289").mockRejectedValueOnce(new Error("exited"));
    expect([...await readNativeExecutablePaths([12, 13])]).toEqual([[12, "/home/test/.local/share/claude/versions/2.1.289"]]);
    expect(readlink.mock.calls).toEqual([["/proc/12/exe"], ["/proc/13/exe"]]);
    expect(execute).not.toHaveBeenCalled();
  });
  it("uses one bounded macOS invocation with numeric argv for the entire sample", async () => {
    setPlatform("darwin");
    execute.mockResolvedValue({ stdout: JSON.stringify([[12, "/a/2.1.289"], [13, null]]) });
    expect([...await readNativeExecutablePaths([12, 13, 12, 0, -1, NaN, 1.5])]).toEqual([[12, "/a/2.1.289"]]);
    expect(execute).toHaveBeenCalledTimes(1);
    const [file, args, options] = execute.mock.calls[0]!;
    expect(file).toBe("/usr/bin/osascript");
    expect(args.slice(0, 3)).toEqual(["-l", "JavaScript", "-e"]);
    expect(args.slice(4)).toEqual(["12", "13"]);
    expect(args[3]).toContain("proc_pidpath");
    expect(options).toMatchObject({ timeout: 2000, maxBuffer: 1048576 });
  });
  it.each(["unavailable", "malformed", "invalid paths"])("does not invent a witness on %s", async (mode) => {
    setPlatform("darwin");
    if (mode === "unavailable") execute.mockRejectedValue(new Error("timeout/denied"));
    else execute.mockResolvedValue({ stdout: mode === "malformed" ? "not json" : JSON.stringify([[12, "relative"], [13, "/a/../b"], [14, "/a\0b"], [999, "/a"]]) });
    expect((await readNativeExecutablePaths([12, 13, 14])).size).toBe(0);
  });
  it("does no work for an empty request or unsupported platform, and caps batch size", async () => {
    setPlatform("darwin");
    expect((await readNativeExecutablePaths([])).size).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    execute.mockResolvedValue({ stdout: "[]" });
    await readNativeExecutablePaths(Array.from({ length: 1100 }, (_, i) => i + 1));
    expect(execute.mock.calls[0]![1]).toHaveLength(1028);
    setPlatform("win32");
    expect((await readNativeExecutablePaths([12])).size).toBe(0);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it.skipIf(platform !== "linux")("reads the actual Linux test process without a provider or native seat", async () => {
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    readlink.mockImplementation(fs.readlink);
    expect((await readNativeExecutablePaths([process.pid])).get(process.pid)).toBe(await fs.realpath(process.execPath));
  });
});
