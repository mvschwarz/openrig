// #980: setup and doctor check that tmux can serve `capture-pane -p`. The check is the getting-started guide's: a throwaway
// socket with no config, so the person's own sessions are never touched. Every command is bounded, and the throwaway server
// always gets a cleanup attempt.
import { describe, expect, it } from "vitest";
import { probeTmuxCapture, TMUX_CAPTURE_PROBE_TIMEOUT_MS } from "../src/tmux-health.js";
import { doctorExec } from "../src/commands/doctor.js";
import { defaultDeps } from "../src/commands/setup.js";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

describe("probeTmuxCapture", () => {
  it("isolates all native commands in one disposable home without altering the parent", () => {
    const before = { ...process.env };
    const environments: NodeJS.ProcessEnv[] = [];
    const result = probeTmuxCapture((_cmd, opts) => {
      expect(opts.env).toBeDefined();
      expect(existsSync(opts.env!.HOME!)).toBe(true);
      environments.push(opts.env!);
      return "";
    }, "owned-native-fixture", "win32");
    expect(result).toEqual({ status: "pass" });
    expect(environments).toHaveLength(3);
    expect(environments.every(env => env === environments[0])).toBe(true);
    const env = environments[0]!;
    expect(env.HOME).toBe(env.USERPROFILE);
    expect(env.PSMUX_DATA_DIR).toBe(join(env.HOME!, "psmux"));
    expect(Object.keys(env).filter(key => ["TMUX", "TMUX_PANE"].includes(key.toUpperCase()))).toEqual([]);
    expect(existsSync(env.HOME!)).toBe(false);
    expect(process.env).toEqual(before);
  });

  it.each([["doctor", doctorExec], ["setup", defaultDeps().exec]] as const)("%s forwards the capture child environment", (_name, exec) => {
    const output = exec(`"${process.execPath}" -p "process.env.OPENRIG_TEST_CAPTURE_MARKER"`, {
      timeoutMs: 5000, env: { ...process.env, OPENRIG_TEST_CAPTURE_MARKER: "owned-capture-environment" },
    });
    expect(output.trim()).toBe("owned-capture-environment");
  });

  it.each([false, true])("keeps failed creation and cleanup in the same native namespace (cleanup refused: %s)", refuseCleanup => {
    let home: string | undefined;
    const environments: NodeJS.ProcessEnv[] = [];
    try {
      const result = probeTmuxCapture((cmd, opts) => {
        home = opts.env!.HOME;
        environments.push(opts.env!);
        if (cmd.includes("new-session")) throw Error("owned create failed");
        if (refuseCleanup) throw Error("owned cleanup unconfirmed");
        return "";
      }, "owned-failure-fixture", "win32");
      expect(result).toEqual({ status: "skipped", detail: "owned create failed" });
      expect(environments).toHaveLength(2);
      expect(environments[0]).toBe(environments[1]);
      expect(existsSync(home!)).toBe(refuseCleanup);
    } finally {
      // The injected executor never starts a process; only its fixture directory exists.
      if (home) rmSync(home, { recursive: true, force: true });
    }
  });
  const KILL = "tmux -L openrig-check-test -f /dev/null kill-server";
  const run = (failure: (cmd: string) => string | null) => {
    const calls: Array<{ cmd: string; timeoutMs: number }> = [];
    const result = probeTmuxCapture((cmd, opts) => {
      calls.push({ cmd, timeoutMs: opts.timeoutMs });
      const message = failure(cmd);
      if (message) throw new Error(message);
      return "";
    }, "openrig-check-test", "linux");
    return { result, calls, cmds: calls.map((c) => c.cmd) };
  };

  it("passes on a tmux that captures, using only a throwaway socket with no config, with every command bounded", () => {
    const { result, calls, cmds } = run(() => null);
    expect(result).toEqual({ status: "pass" });
    expect(cmds).toEqual([
      "tmux -L openrig-check-test -f /dev/null new-session -d -s check",
      "tmux -L openrig-check-test -f /dev/null capture-pane -p -t check",
      KILL,
    ]);
    expect(calls.every((c) => c.timeoutMs === TMUX_CAPTURE_PROBE_TIMEOUT_MS)).toBe(true);
  });

  it("fails with tmux's own words when its server exits on capture-pane -p, and still tries to remove the server", () => {
    const { result, cmds } = run((cmd) => cmd.includes("capture-pane") ? "server exited unexpectedly"
      : cmd.includes("kill-server") ? "no server running on /tmp/tmux-1000/openrig-check-test" : null);
    expect(result).toEqual({ status: "fail", detail: "server exited unexpectedly" });
    expect(cmds.at(-1)).toBe(KILL);
  });

  it("reports not checked when the throwaway server won't start or times out, and still attempts its cleanup", () => {
    for (const message of ["create window failed", "spawnSync /bin/sh ETIMEDOUT"]) {
      const { result, cmds } = run((cmd) => cmd.includes("new-session") ? message : null);
      expect(result).toEqual({ status: "skipped", detail: message });
      // The create may have started a server anyway, so it gets a bounded kill; no capture is tried.
      expect(cmds).toEqual(["tmux -L openrig-check-test -f /dev/null new-session -d -s check", KILL]);
    }
  });
});

describe.skipIf(process.platform !== "win32" || !process.env.OPENRIG_TEST_PSMUX)("native capture health check", () => {
  it("creates and captures an isolated psmux session with the Windows null device", () => {
    const socket = `openrig-check-${randomUUID()}`;
    const calls: string[] = [];
    let probeEnv: NodeJS.ProcessEnv | undefined;
    const result = probeTmuxCapture((cmd, opts) => {
      calls.push(cmd);
      probeEnv = opts.env;
      expect(probeEnv?.HOME).toBeTruthy();
      expect(probeEnv?.PSMUX_DATA_DIR).toBeTruthy();
      return execFileSync(process.env.OPENRIG_TEST_PSMUX!, cmd.split(" ").slice(1), {
        encoding: "utf8", windowsHide: true, timeout: opts.timeoutMs, env: opts.env,
      });
    }, socket);
    expect(result).toEqual({ status: "pass" });
    expect(calls.every(cmd => cmd.includes(" -f NUL "))).toBe(true);
    expect(calls.at(-1)).toContain("kill-server");
    expect(existsSync(probeEnv!.HOME!)).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("doctor's production command runner", () => {
  it("bounds a command given a timeout, so a hanging tmux can't hang rig doctor", () => {
    const started = Date.now();
    expect(() => doctorExec("sleep 5", { timeoutMs: 200 })).toThrow();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(doctorExec("echo ok").trim()).toBe("ok");
  });
});
