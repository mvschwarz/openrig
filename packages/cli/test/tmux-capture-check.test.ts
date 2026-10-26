// #980: setup and doctor check that tmux can serve `capture-pane -p`. The check is the getting-started guide's: a throwaway
// socket with no config, so the person's own sessions are never touched. Every command is bounded, and the throwaway server
// always gets a cleanup attempt.
import { describe, expect, it } from "vitest";
import { probeTmuxCapture, TMUX_CAPTURE_PROBE_TIMEOUT_MS } from "../src/tmux-health.js";
import { doctorExec } from "../src/commands/doctor.js";

describe("probeTmuxCapture", () => {
  const KILL = "tmux -L openrig-check-test -f /dev/null kill-server";
  const run = (failure: (cmd: string) => string | null) => {
    const calls: Array<{ cmd: string; timeoutMs: number }> = [];
    const result = probeTmuxCapture((cmd, opts) => {
      calls.push({ cmd, timeoutMs: opts.timeoutMs });
      const message = failure(cmd);
      if (message) throw new Error(message);
      return "";
    }, "openrig-check-test");
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

describe.skipIf(process.platform === "win32")("doctor's production command runner", () => {
  it("bounds a command given a timeout, so a hanging tmux can't hang rig doctor", () => {
    const started = Date.now();
    expect(() => doctorExec("sleep 5", { timeoutMs: 200 })).toThrow();
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(doctorExec("echo ok").trim()).toBe("ok");
  });
});
