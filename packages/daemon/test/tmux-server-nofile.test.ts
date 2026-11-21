import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startsServerOnly, TMUX_SERVER_LIMIT_PREFIX, TMUX_SERVER_LIMIT_WARNING, TMUX_SERVER_NO_SESSION_BUS,
  TMUX_SERVER_SESSION_BUS, tmuxServerStartCommand } from "../src/tmux-server-start.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { execArgvCommand, execTmuxCommand } from "../src/adapters/tmux-exec.js";

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

// #3253: a systemd-enabled tmux moves each new pane into a tmux-spawn-*.scope through its server's session bus. Only the
// server process OpenRig starts goes without one; the panes get the starting process's value back.
describe.skipIf(process.platform === "win32")("tmux server start without a session bus (#3253)", () => {
  it("knows a bare server start from a tmux command that takes -D", () => {
    for (const cmd of ["tmux -D </dev/null >/dev/null 2>&1 &", "tmux -f /dev/null -S '/a b/s' -D </dev/null &", "tmux -L x -D",
      `tmux -S '/tmp/it'"'"'s dir/s' -D </dev/null >/dev/null 2>&1 &`]) {
      expect(startsServerOnly(cmd), cmd).toBe(true);
    }
    for (const cmd of ["tmux select-pane -D", "tmux resize-pane -D 2", "tmux -S /s attach-session -D -t x",
      "tmux new-session -d", "tmux start-server ; source-file f", "systemd-run --user --scope -- tmux -D", "tmux -S -D new-session"]) {
      expect(startsServerOnly(cmd), cmd).toBe(false);
    }
  });

  it("reaches a server started in the background by the shell", () => {
    // Without the variable in the starting environment: a bare assignment would then not reach the server.
    const env = { ...process.env };
    delete env.DBUS_SESSION_BUS_ADDRESS;
    const result = spawnSync("/bin/sh", ["-c", TMUX_SERVER_LIMIT_PREFIX + TMUX_SERVER_NO_SESSION_BUS +
      'exec /bin/sh -c \'printf %s "${DBUS_SESSION_BUS_ADDRESS-unset}"\' &\nwait'], { encoding: "utf8", timeout: 10_000, env });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(TMUX_SERVER_SESSION_BUS);
  });

  it("is the unknown disabled: transport, marked as OpenRig's own, the same in every daemon process", () => {
    expect(TMUX_SERVER_SESSION_BUS).toBe("disabled:openrig=tmux-server");
  });

  it.skipIf(!tmux || process.platform !== "linux")("a daemon that starts again gives the bus back to a server still holding OpenRig's address, and only to that", async () => {
    const dir = mkdtempSync(join(tmpdir(), "or-nobus-restart-"));
    const socket = join(dir, "socket");
    const query = (...args: string[]) => execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8", timeout: 5000 });
    const global = () => query("show-environment", "-g").split("\n").find(v => /^-?DBUS_SESSION_BUS_ADDRESS(=|$)/.test(v));
    const adapter = () => new TmuxAdapter(execTmuxCommand, undefined, execArgvCommand, ["-f", "/dev/null", "-S", socket]);
    vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/nonexistent/openrig-3253-bus");
    vi.stubEnv("MANAGERPID", undefined);
    try {
      expect(await adapter().startServer()).toEqual({ ok: true });
      // The daemon stopped before it gave the bus back: the server, which outlives it, still holds OpenRig's address.
      query("set-environment", "-g", "DBUS_SESSION_BUS_ADDRESS", TMUX_SERVER_SESSION_BUS);
      expect(await adapter().startServer()).toEqual({ ok: true });
      expect(global()).toBe("DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent/openrig-3253-bus");
      // A plain disabled: (a person's own) is left as it is by a daemon that starts again.
      query("set-environment", "-g", "DBUS_SESSION_BUS_ADDRESS", "disabled:");
      expect(await adapter().startServer()).toEqual({ ok: true });
      expect(global()).toBe("DBUS_SESSION_BUS_ADDRESS=disabled:");
    } finally {
      vi.unstubAllEnvs();
      try { query("kill-server"); } catch { /* Only this test's exact private socket. */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!tmux || process.platform !== "linux").each([
    ["startServer, a session bus address", "start", "unix:path=/nonexistent/openrig-3253-bus"],
    ["startServer, no session bus address", "start", undefined],
    ["a launch that finds no server", "launch", "unix:path=/nonexistent/openrig-3253-bus"],
    ["a probe session that finds no server", "probe", "unix:path=/nonexistent/openrig-3253-bus"],
  ])("a server it starts has no bus in its own process, and its global environment keeps the daemon's (%s)", async (_, how, bus) => {
    const dir = mkdtempSync(join(tmpdir(), "or-nobus-"));
    const socket = join(dir, "socket");
    const query = (...args: string[]) => execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8", timeout: 5000 });
    vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", bus);
    vi.stubEnv("MANAGERPID", undefined);
    try {
      const adapter = new TmuxAdapter(execTmuxCommand, undefined, execArgvCommand, ["-f", "/dev/null", "-S", socket]);
      if (how === "start") expect(await adapter.startServer()).toEqual({ ok: true });
      else if (how === "launch") expect(await adapter.createSession("nobus", dir, { OPENRIG_NODE_ID: "nobus" })).toMatchObject({ ok: true });
      else expect(await adapter.createProbeSession("openrig-nobus-probe")).toEqual({ ok: true });
      const pid = query("display-message", "-p", "#{pid}").trim();
      const own = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").find(v => v.startsWith("DBUS_SESSION_BUS_ADDRESS="));
      expect(own).toBe(`DBUS_SESSION_BUS_ADDRESS=${TMUX_SERVER_SESSION_BUS}`);
      const global = query("show-environment", "-g").split("\n").find(v => /^-?DBUS_SESSION_BUS_ADDRESS(=|$)/.test(v));
      if (bus === undefined) expect(global ?? "").not.toMatch(/^DBUS_SESSION_BUS_ADDRESS=/);
      else expect(global).toBe(`DBUS_SESSION_BUS_ADDRESS=${bus}`);
    } finally {
      vi.unstubAllEnvs();
      try { query("kill-server"); } catch { /* Only this test's exact private socket. */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
