import { describe, expect, it, vi } from "vitest";
import { runSetup, type SetupDeps } from "../src/commands/setup.js";

function fixture(installed = false) {
  let present = installed;
  const exec = vi.fn((cmd: string, _opts?: { timeoutMs?: number }) => {
    if (cmd.endsWith("herdr --version") || cmd.endsWith("herdr' --version")) {
      if (!present) throw new Error("missing herdr");
      return "herdr 0.9.3";
    }
    if (cmd === "curl -fsSL https://herdr.dev/install.sh | sh") { present = true; return "installed"; }
    if (cmd === "tmux -V") return "tmux 3.4";
    return "available";
  });
  const deps: SetupDeps = { platform: "darwin", env: { HOME: "/fixture" }, exec, exists: () => false, readFile: () => null, writeFile: vi.fn(), mkdirp: vi.fn() };
  return { deps, exec };
}

describe("setup Herdr default", () => {
  it.each(["darwin", "linux"] as const)("installs and verifies missing Herdr on %s without opening a view", async platform => {
    const f = fixture(); f.deps.platform = platform;
    const result = await runSetup(f.deps, {});
    expect(result.steps).toContainEqual(expect.objectContaining({ id: "herdr_install", status: "applied" }));
    expect(f.exec).toHaveBeenCalledWith("curl -fsSL https://herdr.dev/install.sh | sh", { timeoutMs: 300_000 });
    expect(f.exec.mock.calls.some(([cmd]) => /osascript|open -a|cmux|terminal open/.test(cmd))).toBe(false);
    expect(vi.mocked(f.deps.writeFile).mock.calls.some(([file]) => file.includes("cmux"))).toBe(false);
  });
  it("reuses an installed binary without installing again", async () => {
    const f = fixture(true);
    const result = await runSetup(f.deps, {});
    expect(result.steps).toContainEqual(expect.objectContaining({ id: "herdr_install", status: "pass" }));
    expect(f.exec.mock.calls.some(([cmd]) => cmd.includes("herdr.dev/install"))).toBe(false);
  });
  it("honors decline in both real and dry-run modes without any Herdr probe", async () => {
    for (const dryRun of [false, true]) {
      const f = fixture();
      const result = await runSetup(f.deps, { herdr: false, dryRun });
      expect(result.steps).toContainEqual(expect.objectContaining({ id: "herdr_install", status: "skipped", message: expect.stringContaining("declined") }));
      expect(f.exec.mock.calls.some(([cmd]) => cmd.includes("herdr"))).toBe(false);
    }
  });
  it("retains install failure and continues other setup steps", async () => {
    const f = fixture();
    const original = f.deps.exec;
    f.deps.exec = (cmd, opts) => { if (cmd.includes("herdr.dev/install")) throw new Error("install timeout"); return original(cmd, opts); };
    const result = await runSetup(f.deps, {});
    expect(result.ready).toBe(false);
    expect(result.steps).toContainEqual(expect.objectContaining({ id: "herdr_install", status: "fail", message: expect.stringContaining("install timeout") }));
    expect(result.steps).toContainEqual(expect.objectContaining({ id: "claude_auth", status: "pass" }));
  });
});
