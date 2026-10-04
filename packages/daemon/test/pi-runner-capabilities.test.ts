import { describe, expect, it } from "vitest";
import { piLaunchCapabilityError, resolveRuntimeExecutable } from "../src/adapters/pi-runner.js";

describe("Pi pane capability check", () => {
  it.each(["approve", "no-approve"] as const)("names the actual executable and rejected managed flag (%s)", trust => {
    const error = piLaunchCapabilityError("/pane/old/pi", trust,
      `\x1b[31mError: Unknown options: --name, --${trust}\x1b[0m`, () => "0.73.1\n");
    expect(error).toContain("/pane/old/pi (version 0.73.1)");
    expect(error).toContain("@earendil-works/pi-coding-agent");
    expect(error).toContain("command -v pi");
  });

  it.each(["custom Pi startup", "config failed", "Unknown option: --help", "Unknown option: --names"])(
    "leaves unrecognised diagnostics alone: %s", line => {
      expect(piLaunchCapabilityError("/pane/pi", "approve", line, () => { throw new Error("must not probe"); }))
        .toBeUndefined();
    });

  it("keeps a timed-out version diagnostic nonfatal", () => {
    expect(piLaunchCapabilityError("/pane/pi", "approve", "Unknown option: --name", () => {
      throw { code: "ETIMEDOUT" };
    })).toContain("unknown version");
  });

  it("preserves relative and empty Pi PATH entries at the child cwd", () => {
    const ops = { isExecutable: (p: string) => p === "/project/tools/pi" || p === "/project/pi",
      realpath: (p: string) => p, run: () => { throw new Error("not a shim"); } };
    expect(resolveRuntimeExecutable("pi", { PATH: "tools:/usr/bin" }, ops, "/project"))
      .toEqual({ ok: true, path: "/project/tools/pi" });
    expect(resolveRuntimeExecutable("pi", { PATH: ":/usr/bin" }, ops, "/project"))
      .toEqual({ ok: true, path: "/project/pi" });
  });

  it("keeps the native POSIX default search when Pi has no PATH variable", () => {
    const ops = { isExecutable: (p: string) => p === "/usr/bin/pi", realpath: (p: string) => p,
      run: () => { throw new Error("not a shim"); } };
    expect(resolveRuntimeExecutable("pi", {}, ops, "/project"))
      .toEqual({ ok: true, path: "/usr/bin/pi" });
  });
});
