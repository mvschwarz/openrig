import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TMUX_SERVER_LIMIT_PREFIX, TMUX_SERVER_LIMIT_WARNING, tmuxServerStartCommand } from "../src/tmux-server-start.js";

const shell = (script: string, args: string[] = []) => spawnSync("/bin/sh", ["-c", script, "nofile-test", ...args], { encoding: "utf8", timeout: 10_000 });
let tmux = false;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); tmux = true; } catch { /* Native prerequisite absent. */ }

describe.skipIf(process.platform === "win32")("tmux server creation limit", () => {
  it("raises only the soft limit, capped by the hard limit and 8192", () => {
    const result = shell('ulimit -S -n 256; ' + TMUX_SERVER_LIMIT_PREFIX + 'printf "%s %s" "$(ulimit -S -n)" "$(ulimit -H -n)"');
    expect(result.status).toBe(0);
    const [soft, hard] = result.stdout.split(" ");
    expect(Number(soft)).toBe(hard === "unlimited" ? 8192 : Math.min(Number(hard), 8192));
    expect(result.stderr).toBe("");
  });

  it("does not lower a soft limit above the target", ({ skip }) => {
    const result = shell('ulimit -S -n 16384 2>/dev/null || exit 77; ' + TMUX_SERVER_LIMIT_PREFIX + 'ulimit -S -n');
    if (result.status === 77) skip(); // This host's hard limit cannot supply the fixture.
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("16384");
  });

  it("honours a lower hard limit without changing it", ({ skip }) => {
    const result = shell('ulimit -S -n 256; ulimit -H -n 1024 2>/dev/null || exit 77; ' + TMUX_SERVER_LIMIT_PREFIX + 'printf "%s %s" "$(ulimit -S -n)" "$(ulimit -H -n)"');
    if (result.status === 77) skip();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("1024 1024");
    expect(result.stderr).toBe("");
  });

  it("continues exactly once with unchanged argv and limit when raising fails", async () => {
    const command = tmuxServerStartCommand("/bin/sh", ["-c", 'printf "ran:%s:%s" "$(ulimit -S -n)" "$1"', "payload", "quoted ' $HOME ; new-session", "new-session"]);
    // Supply a real low inherited soft limit and a shell builtin override that refuses only a raise.
    const prelude = 'ulimit -S -n 256; ulimit() { case "$*" in "-H -n") printf "8192\\n";; "-S -n 8192") return 1;; *) command ulimit "$@";; esac; }; ';
    // Execute the production script in that same shell so the failed-set premise reaches it.
    const result = spawnSync("/bin/sh", ["-c", prelude + command.args[1], ...command.args.slice(2)], { encoding: "utf8", timeout: 10_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ran:256:quoted ' $HOME ; new-session");
    expect(result.stderr.trim()).toBe(TMUX_SERVER_LIMIT_WARNING);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.resetModules();
      const { reportTmuxServerLimit } = await import("../src/tmux-server-start.js");
      reportTmuxServerLimit(result.stderr);
      reportTmuxServerLimit(result.stderr);
      expect(warn).toHaveBeenCalledExactlyOnceWith(TMUX_SERVER_LIMIT_WARNING);
    } finally { warn.mockRestore(); }
  });

  it("keeps ordinary capture/send commands direct", () => {
    for (const args of [["capture-pane", "-p"], ["send-keys", "-l", "text"], ["-V"]]) {
      expect(tmuxServerStartCommand("tmux", args)).toEqual({ file: "tmux", args });
    }
  });

  it.skipIf(!tmux)("a fresh private server inherits the raised limit; an existing one is preserved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "or-nofile-"));
    const socket = join(dir, "socket");
    const limit = join(dir, "limit");
    const query = (...args: string[]) => execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8", timeout: 5000 });
    try {
      const start = shell('ulimit -S -n 256; ' + TMUX_SERVER_LIMIT_PREFIX + 'exec tmux -S "$1" -f /dev/null new-session -d -s owned /bin/sh -c \'ulimit -S -n > "$1"; sleep 30\' pane "$2"', [socket, limit]);
      expect(start.status, start.stderr).toBe(0);
      let actual = "";
      for (let i = 0; i < 100; i++) {
        try { actual = readFileSync(limit, "utf8").trim(); if (actual) break; } catch { /* Pane is starting. */ }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const hard = shell('ulimit -H -n').stdout.trim();
      expect(Number(actual)).toBe(Math.min(hard === "unlimited" ? Infinity : Number(hard), 8192));
      const pid = query("display-message", "-p", "#{pid}").trim();
      const again = shell('ulimit -S -n 256; ' + TMUX_SERVER_LIMIT_PREFIX + 'exec tmux -S "$1" new-session -d -s another sleep 30', [socket]);
      expect(again.status, again.stderr).toBe(0);
      expect(query("display-message", "-p", "#{pid}").trim()).toBe(pid);
      expect(query("list-sessions", "-F", "#{session_name}")).toContain("owned");
    } finally {
      try { query("kill-server"); } catch { /* Only this test's exact private socket. */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
