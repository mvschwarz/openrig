import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { execArgvCommand, resolveOnPath } from "../src/adapters/tmux-exec.js";

// Fake `tmux` binaries in private directories: each prints its own directory, so a call shows which one ran.
// PATH holds only these directories: a real tmux later on PATH would answer for a fake that has gone.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-tmux-resolve-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

function dir(name: string, tmux?: "exec" | "plain" | "directory"): string {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  const bin = path.join(d, "tmux");
  if (tmux === "directory") fs.mkdirSync(bin);
  else if (tmux) fs.writeFileSync(bin, `#!/bin/sh\necho "${name} $*"\n`, { mode: tmux === "exec" ? 0o755 : 0o644 });
  return d;
}

// Each case spawns a few shells, which takes seconds on a loaded host.
describe.skipIf(process.platform === "win32")("tmux binary resolution", { timeout: 60_000 }, () => {
  it("takes the first regular executable in PATH order, as execvp does", () => {
    const first = dir("first", "exec"), second = dir("second", "exec");
    expect(resolveOnPath("tmux", `${first}:${second}`)).toBe(path.join(first, "tmux"));
    expect(resolveOnPath("tmux", `${second}:${first}`)).toBe(path.join(second, "tmux"));
  });

  it("skips a non-executable file, a directory and a missing entry", () => {
    const plain = dir("plain", "plain"), folder = dir("folder", "directory"), empty = dir("empty"), real = dir("real", "exec");
    expect(resolveOnPath("tmux", `${empty}:${plain}:${folder}:${real}`)).toBe(path.join(real, "tmux"));
    expect(resolveOnPath("tmux", `${empty}:${plain}`)).toBeNull();
    expect(resolveOnPath("tmux", undefined)).toBeNull();
  });

  it("leaves the lookup to the spawn when an earlier entry depends on the cwd", () => {
    const real = dir("cwd-real", "exec");
    expect(resolveOnPath("tmux", `relative/bin:${real}`)).toBeNull();
    expect(resolveOnPath("tmux", `:${real}`)).toBeNull();
    expect(resolveOnPath("tmux", `${real}:relative/bin`)).toBe(path.join(real, "tmux"));
  });

  it("runs the resolved binary with the argv unchanged, and follows a PATH change", async () => {
    const a = dir("run-a", "exec"), b = dir("run-b", "exec");
    vi.stubEnv("PATH", `${a}:${b}`);
    expect(await execArgvCommand(["tmux", "list-sessions", "-F", "#{session_name} x"])).toBe("run-a list-sessions -F #{session_name} x\n");
    vi.stubEnv("PATH", `${b}:${a}`);
    expect(await execArgvCommand(["tmux", "-V"])).toBe("run-b -V\n");
  });

  it("looks the binary up again once when the cached one has gone", async () => {
    const a = dir("gone-a", "exec"), b = dir("gone-b", "exec");
    vi.stubEnv("PATH", `${a}:${b}`);
    expect(await execArgvCommand(["tmux", "-V"])).toBe("gone-a -V\n");
    fs.rmSync(path.join(a, "tmux"));
    expect(await execArgvCommand(["tmux", "-V"])).toBe("gone-b -V\n");
    // Only a non-executable one is left: the shell reports it, as on the shell transport.
    fs.chmodSync(path.join(b, "tmux"), 0o644);
    await expect(execArgvCommand(["tmux", "-V"])).rejects.toMatchObject({ code: 126 });
  });

  it("fails like the shell transport when no PATH entry has the binary", async () => {
    vi.stubEnv("PATH", `${dir("none")}:/nonexistent`);
    await expect(execArgvCommand(["tmux", "-V"])).rejects.toMatchObject({ code: 127, message: expect.stringMatching(/tmux: .*not found/) });
  });

  // Accepted: a tmux installed earlier on PATH is seen when PATH changes, the cached one fails, or the daemon restarts.
  it("keeps the cached binary while it still runs, until PATH changes", async () => {
    const early = dir("stale-early"), late = dir("stale-late", "exec");
    vi.stubEnv("PATH", `${early}:${late}`);
    expect(await execArgvCommand(["tmux", "-V"])).toBe("stale-late -V\n");
    fs.writeFileSync(path.join(early, "tmux"), `#!/bin/sh\necho "stale-early $*"\n`, { mode: 0o755 });
    expect(await execArgvCommand(["tmux", "-V"])).toBe("stale-late -V\n");
    vi.stubEnv("PATH", `${early}:${late}:/nonexistent`);
    expect(await execArgvCommand(["tmux", "-V"])).toBe("stale-early -V\n");
  });
});
