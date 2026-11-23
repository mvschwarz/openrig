import { readFileSync } from "node:fs";
import * as lifecycleBudget from "../../daemon/src/daemon-shutdown.js";
import { describe, it, expect, vi } from "vitest";
import { DAEMON_START_OUTPUT_TAIL_CHARS, daemonStartArgs, daemonStartTimeoutMs, runDaemonStart, type DaemonStartError } from "../src/crash-cart/start-daemon.js";
import { resolveCrashCartKey } from "../src/crash-cart/keys.js";

// #3637: Node's spawn on EMFILE or ENFILE returns a child with no stdio streams and emits `error` on the next tick.
// The cell below turns that on for one start; every other start in this file runs the real spawn.
const emfile = vi.hoisted(() => ({ on: false, kills: 0 }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...real,
    spawn: (...args: Parameters<typeof real.spawn>) => {
      if (!emfile.on) return real.spawn(...args);
      const child = Object.assign(new EventEmitter(), {
        stdout: null, stderr: null, stdin: null, pid: undefined,
        kill: () => { emfile.kills += 1; return false; },
      });
      process.nextTick(() => {
        child.emit("error", Object.assign(new Error("spawn rig EMFILE"), { code: "EMFILE", errno: -24, syscall: "spawn rig" }));
        child.emit("close", -24, null);   // as Node does after a spawn error
      });
      return child;
    },
  };
});

describe("local startup target", () => {
  it("starts only the intended local daemon, leaving occupant selection to the user", () => {
    // The default bind is 127.0.0.1 plus Tailscale when present, so naming 127.0.0.1 would drop the Tailscale listener.
    expect(daemonStartArgs("http://127.0.0.1:17433")).toEqual([
      "daemon", "start", "--no-kernel", "--port", "17433",
    ]);
  });
  it.each([["http://localhost:7433", "localhost"], ["http://[::1]:7433", "::1"]])(
    "names %s's host, which the default bind doesn't listen on", (target, host) => {
      expect(daemonStartArgs(target)).toEqual(["daemon", "start", "--no-kernel", "--host", host, "--port", "7433"]);
    },
  );
  it.each(["https://example.test", "http://10.0.0.2:7433", "http://user:password@localhost:7433", "http://localhost:7433/other"])(
    "does not turn %s into local startup authority", (target) => {
      expect(() => daemonStartArgs(target)).toThrow("no local daemon was started");
    },
  );
  it("unavailable prerequisites permit inspection/retry but no recovery effects", () => {
    const opts = { unavailable: "native load failed" };
    expect(resolveCrashCartKey("r", opts)).toBe("retry");
    expect(resolveCrashCartKey("d", opts)).toBe("details");
    for (const key of ["s", "n", "enter", "i"]) expect(resolveCrashCartKey(key, opts)).toBeNull();
  });
});

// The launcher must survive the CLI's current-child wait and cleanup budget.
describe("daemon start caller budget", () => {
  it("derives the caller timeout from the same wait/probe budgets as the CLI, with cleanup and margin", () => {
    const budget = lifecycleBudget as unknown as Record<string, number>;
    expect(budget.DAEMON_START_READINESS_WAIT_MS).toBe(180_000);
    expect(budget.DAEMON_START_COMMAND_TIMEOUT_MS).toBeGreaterThanOrEqual(
      budget.DAEMON_START_READINESS_WAIT_MS! + budget.DAEMON_START_PROBE_TIMEOUT_MS! + budget.DAEMON_STOP_WAIT_MS! + 5_000,
    );
    const source = readFileSync(new URL("../../cli/src/daemon-lifecycle.ts", import.meta.url), "utf8");
    expect(source).toContain("DAEMON_START_READINESS_WAIT_MS as STARTUP_READINESS_DEADLINE_MS");
    expect(source).toContain("DAEMON_START_PROBE_TIMEOUT_MS as STARTUP_PROBE_TIMEOUT_MS");
  });

  it("bounds a start by the resolved daemon.start_readiness_wait_seconds plus probe, cleanup and margin", () => {
    const budget = lifecycleBudget as unknown as Record<string, number>;
    const margin = budget.DAEMON_START_PROBE_TIMEOUT_MS! + budget.DAEMON_STOP_WAIT_MS! + 5_000;
    expect(daemonStartTimeoutMs(180)).toBe(budget.DAEMON_START_COMMAND_TIMEOUT_MS);
    expect(daemonStartTimeoutMs(30)).toBe(30_000 + margin);
    expect(daemonStartTimeoutMs(600)).toBe(600_000 + margin);
    expect(daemonStartTimeoutMs(900)).toBe(900_000 + margin);
  });

  it("accepts waits up to the longest whose budget a Node timer can hold", () => {
    const max = (lifecycleBudget as unknown as Record<string, number>).DAEMON_START_READINESS_WAIT_MAX_SECONDS!;
    expect(daemonStartTimeoutMs(max)).toBeLessThanOrEqual(2 ** 31 - 1);
    expect(daemonStartTimeoutMs(max) + 1_000).toBeGreaterThan(2 ** 31 - 1);
    expect(max).toBe(2147464);
  });

  it.each([null, undefined, "240", 0, 2147465, 1.5])("falls back to the longest accepted wait when the setting reads %s", (setting) => {
    // A shorter backstop could end a start the CLI is still waiting on; the CLI keeps its own deadline.
    expect(daemonStartTimeoutMs(setting)).toBe(daemonStartTimeoutMs(2147464));
  });

  it("uses that timeout for all three asynchronous TUI daemon-start calls", () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(source.match(/startTimeoutMs\((?:true)?\)\.then\(\(timeout\) =>/g)).toHaveLength(3);
    // The restore start runs the bare `rig`, so it reads the wait from the bare `rig` too.
    expect(source).toMatch(/startTimeoutMs\(true\)\.then\(\(timeout\) => new Promise<void>\(\(resolve, reject\) =>\s+runDaemonStart\("rig", \["daemon", "start"\]/);
    // All three read the CLI's output as it arrives (runDaemonStart), never through execFile's maxBuffer.
    expect(source.match(/runDaemonStart\([^\n]*\{ cwd: helperCwd\(\), timeout \}/g)).toHaveLength(3);
    expect(source).not.toMatch(/execFile\([^\n]*\{ cwd: helperCwd\(\), timeout \}/);
    expect(source).not.toMatch(/DAEMON_START_COMMAND_TIMEOUT_MS/);
    expect(source).not.toMatch(/execFileSync/);
  });
});

// #3637: a long wait prints a progress line about every 20 s; execFile's default 1 MiB maxBuffer would stop the CLI
// after about 50 h of them. A finite fake child prints more than 1 MiB before it's ready instead of waiting days.
describe("daemon start output", () => {
  const LINES = 20_000;
  const LINE = "Still waiting for the daemon to answer its readiness probe (progress line padding)....\n";
  const run = (script: string, timeout = 60_000) => new Promise<{ error: DaemonStartError | null; stdout: string; stderr: string }>((resolve) => {
    runDaemonStart(process.execPath, ["-e", script], { cwd: process.cwd(), timeout }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });

  it("reads the output as it arrives, so more than 1 MiB before ready doesn't end the start", async () => {
    expect(LINES * LINE.length).toBeGreaterThan(1024 * 1024);
    const { error, stdout } = await run(`process.stdout.write(${JSON.stringify(LINE)}.repeat(${LINES}) + "daemon ready\\n")`);
    expect(error).toBeNull();
    expect(stdout.length).toBeLessThanOrEqual(DAEMON_START_OUTPUT_TAIL_CHARS);
    expect(stdout.endsWith("daemon ready\n")).toBe(true);
  });

  it("keeps only a bounded tail of a failed start's output for the error message", async () => {
    const { error, stdout, stderr } = await run(
      `process.stdout.write(${JSON.stringify(LINE)}.repeat(${LINES})); process.stderr.write(${JSON.stringify(LINE)}.repeat(${LINES}) + "port 7433 is held\\n"); process.exitCode = 3`,
    );
    expect(error?.code).toBe(3);
    expect(stdout.length).toBeLessThanOrEqual(DAEMON_START_OUTPUT_TAIL_CHARS);
    expect(stderr.length).toBeLessThanOrEqual(DAEMON_START_OUTPUT_TAIL_CHARS);
    expect(stderr.endsWith("port 7433 is held\n")).toBe(true);
    expect(error?.message.length).toBeLessThan(DAEMON_START_OUTPUT_TAIL_CHARS + 1_000);
    expect(error?.message).toContain("port 7433 is held");
  });

  it("ends a start that outlives its timeout with SIGTERM", async () => {
    const { error } = await run("setTimeout(() => {}, 60_000)", 200);
    expect(error).toMatchObject({ killed: true, signal: "SIGTERM" });
  });

  it("ends with the error, once, when the spawn fails before its streams exist (EMFILE)", async () => {
    emfile.on = true;
    emfile.kills = 0;
    try {
      const calls: Array<DaemonStartError | null> = [];
      await new Promise<void>((resolve, reject) => {
        try {
          runDaemonStart("rig", ["daemon", "start"], { cwd: process.cwd(), timeout: 50 }, (error) => { calls.push(error); resolve(); });
        } catch (thrown) { reject(thrown); }
      });
      await new Promise((resolve) => setTimeout(resolve, 150));   // past the timeout: the cleared timer never fires
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ code: "EMFILE" });
      expect(emfile.kills).toBe(0);
    } finally {
      emfile.on = false;
    }
  });

  it("returns at the timeout even when a grandchild still holds the output pipes", async () => {
    const started = Date.now();
    const { error } = await run(
      `require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { stdio: "inherit" }); setTimeout(() => {}, 60_000)`,
      200,
    );
    expect(error).toMatchObject({ killed: true, signal: "SIGTERM" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
