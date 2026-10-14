import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { execArgvCommand, execCommand } from "../src/adapters/tmux-exec.js";

// A fake `tmux` in a private home: it prints its argv, so a call shows the binary ran with the arguments unchanged.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-tmux-path-"));
fs.mkdirSync(path.join(home, "bin"));
fs.writeFileSync(path.join(home, "bin", "tmux"), `#!/bin/sh\nfor a in "$@"; do printf '[%s]' "$a"; done\necho\n`, { mode: 0o755 });
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

// Only a /bin/sh that expands a literal ~ in PATH (bash) finds the fake; dash does not, so the premise is absent there.
const shellExpandsTildeInPath = process.platform !== "win32" && (() => {
  try {
    const found = execFileSync("/bin/sh", ["-c", "command -v tmux"], { env: { HOME: home, PATH: "~/bin:/usr/bin:/bin" }, encoding: "utf8" });
    return found.trim().startsWith(home);
  } catch { return false; }
})();

describe.skipIf(process.platform === "win32")("tmux on PATH without a shell", { timeout: 60_000 }, () => {
  it.skipIf(!shellExpandsTildeInPath)("finds tmux through a literal ~ PATH entry, as the shell path does", async () => {
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", "~/bin:/usr/bin:/bin");
    const argv = ["tmux", "list-sessions", "-F", "#{session_name} 'x' $HOME"];
    expect(await execArgvCommand(argv)).toBe("[list-sessions][-F][#{session_name} 'x' $HOME]\n");
    expect(await execCommand(`tmux list-sessions -F '#{session_name} '"'"'x'"'"' $HOME'`)).toBe(await execArgvCommand(argv));
  });

  it("still fails when no PATH entry has tmux", async () => {
    vi.stubEnv("PATH", path.join(home, "missing"));
    await expect(execArgvCommand(["tmux", "-V"])).rejects.toThrow(/tmux/);
  });
});
