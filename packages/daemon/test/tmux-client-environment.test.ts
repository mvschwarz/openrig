import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execArgvCommand, execCommand, execTmuxCommand, spawnTmuxClient } from "../src/adapters/tmux-exec.js";

const credentials = ["OPENRIG_ACTIVITY_HOOK_TOKEN", "RIGGED_ACTIVITY_HOOK_TOKEN", "OPENRIG_AUTH_BEARER_TOKEN",
  "OPENRIG_TERMINAL_BEARER_TOKEN", "OPENRIG_RELAY_INBOUND_TOKEN", "OPENRIG_RELAY_OUTBOUND_TOKEN"];
let available = false;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); available = true; } catch { /* native premise absent */ }
afterEach(() => vi.unstubAllEnvs());

describe.skipIf(!available || process.platform === "win32")("private tmux server environment", () => {
  it.each(["argv", "shell", "legacy", "control"])("%s launch excludes daemon credentials but preserves user configuration", async mode => {
    const home = mkdtempSync(join(tmpdir(), "openrig-tmux-env-"));
    // A fresh private server with no config: never connects to the daemon's server.
    const queryEnv = { PATH: process.env.PATH, HOME: home, TMUX_TMPDIR: home };
    for (const key of credentials) vi.stubEnv(key, "synthetic-daemon-value");
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-provider-value");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "1");
    vi.stubEnv("TMUX", undefined);
    vi.stubEnv("TMUX_TMPDIR", home);
    const args = ["-L", "fixture", "-f", "/dev/null", "new-session", "-d", "-s", "probe", "sleep 30"];
    const query = (...argv: string[]) => execFileSync("tmux", ["-L", "fixture", ...argv], { env: queryEnv, encoding: "utf8" });
    try {
      if (mode === "argv") await execArgvCommand(["tmux", ...args]);
      else if (mode === "control") {
        const child = await spawnTmuxClient(args);
        child.stdout.resume(); child.stderr.resume();
        const code = await new Promise<number | null>(resolve => child.once("close", resolve));
        expect(code).toBe(0);
      } else await (mode === "shell" ? execTmuxCommand : execCommand)(`tmux ${args.map(a => "'" + a.replaceAll("'", "'\"'\"'") + "'").join(" ")}`);
      const global = query("show-environment", "-g");
      expect(credentials.filter(key => global.split("\n").some(line => line.startsWith(key + "=")))).toEqual([]);
      expect(global).toContain("ANTHROPIC_API_KEY=synthetic-provider-value");
      expect(global).toContain("CLAUDE_CODE_USE_BEDROCK=1");
      // Removing credentials from the client doesn't remove the explicit per-seat channel.
      await execArgvCommand(["tmux", "-L", "fixture", "set-environment", "-t", "probe", credentials[0]!, "synthetic-seat-value"]);
      expect(query("show-environment", "-t", "probe", credentials[0]!)).toBe(credentials[0] + "=synthetic-seat-value\n");
      expect(process.env.OPENRIG_ACTIVITY_HOOK_TOKEN).toBe("synthetic-daemon-value");
    } finally {
      try { query("kill-server"); } finally { rmSync(home, { recursive: true, force: true }); }
    }
  });
});
