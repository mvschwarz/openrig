import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  startDaemon,
  stopDaemon,
  getDaemonStatus,
  readLogs,
  tailLogs,
  getDaemonPath,
  STATE_FILE,
  LOG_FILE,
  RIGGED_DIR,
  type LifecycleDeps,
  type DaemonState,
} from "../src/daemon-lifecycle.js";

function mockDeps(overrides?: Partial<LifecycleDeps>): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 12345, unref: vi.fn() }) as unknown as ChildProcess),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
    ...overrides,
  };
}

function writtenState(deps: LifecycleDeps): DaemonState {
  const call = (deps.writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
    (c: unknown[]) => (c[0] as string).endsWith("daemon.json")
  );
  if (!call) throw new Error("daemon.json was not written");
  return JSON.parse(call[1] as string) as DaemonState;
}

describe("Daemon Lifecycle", () => {
  // Test 1: start resolves absolute daemon path (not cwd-relative)
  it("getDaemonPath resolves absolute path to packages/daemon from CLI package", () => {
    const daemonPath = getDaemonPath();
    expect(path.isAbsolute(daemonPath)).toBe(true);
    expect(daemonPath).toMatch(/packages\/daemon$/);
    // Derived from import.meta.dirname (CLI src), not process.cwd
    // The path should be sibling to the cli package
    const cliSrc = path.resolve(import.meta.dirname, "../src");
    const expected = path.resolve(cliSrc, "../../daemon");
    expect(daemonPath).toBe(expected);
  });

  // Test 2: start constructs exact spawn command with correct env/redirect
  it("start: constructs spawn with node, daemon entry, env, and log redirect", async () => {
    const deps = mockDeps();
    await startDaemon({ port: 7433, db: "rigged.sqlite" }, deps);

    const spawnMock = deps.spawn as ReturnType<typeof vi.fn>;
    expect(spawnMock).toHaveBeenCalledOnce();

    const [cmd, args, opts] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe("node");
    expect(args[0]).toContain("packages/daemon");
    expect(args[0]).toContain("dist/index.js");
    expect(opts.env).toMatchObject({
      RIGGED_PORT: "7433",
      RIGGED_DB: "rigged.sqlite",
    });
    expect(opts.detached).toBe(true);
  });

  // Test 3: start waits for healthz, writes daemon.json with pid+port+db+startedAt
  it("start: writes daemon.json with pid, port, db, startedAt after healthz", async () => {
    const deps = mockDeps();
    const result = await startDaemon({ port: 8000, db: "test.sqlite" }, deps);

    expect(result.pid).toBe(12345);
    expect(result.port).toBe(8000);
    expect(result.db).toBe("test.sqlite");
    expect(result.startedAt).toBeDefined();

    const state = writtenState(deps);
    expect(state.pid).toBe(12345);
    expect(state.port).toBe(8000);
    expect(state.db).toBe("test.sqlite");
    expect(state.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // Test 4: start already running -> error
  it("start: already running -> throws error", async () => {
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify({ pid: 99, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" });
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
    });

    await expect(startDaemon({}, deps)).rejects.toThrow(/already running/i);
  });

  // Test 5: stop reads pid from daemon.json, sends SIGTERM, removes daemon.json
  it("stop: reads pid, sends SIGTERM, removes daemon.json", async () => {
    const state: DaemonState = { pid: 555, port: 7433, db: "rigged.sqlite", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn()
        .mockReturnValueOnce(true)   // first check: alive
        .mockReturnValueOnce(false), // after kill: dead
    });

    await stopDaemon(deps);

    expect(deps.kill).toHaveBeenCalledWith(555, "SIGTERM");
    expect(deps.removeFile).toHaveBeenCalledWith(STATE_FILE);
  });

  // Test 6: stop not running -> clean message (no throw)
  it("stop: not running -> does not throw", async () => {
    const deps = mockDeps({
      exists: vi.fn(() => false),
    });

    // Should not throw
    await expect(stopDaemon(deps)).resolves.toBeUndefined();
  });

  // Test 7: status reads port from daemon.json, reports running with port
  it("status: running daemon (pid alive + healthz ok) -> { state: 'running', port, pid }", async () => {
    const state: DaemonState = { pid: 777, port: 9000, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
      fetch: vi.fn(async () => ({ ok: true })),
    });

    const status = await getDaemonStatus(deps);
    expect(status.state).toBe("running");
    expect(status.port).toBe(9000);
    expect(status.pid).toBe(777);
    // Must have checked healthz
    expect(deps.fetch).toHaveBeenCalledWith("http://127.0.0.1:9000/healthz");
  });

  // Test 8: status stopped (no daemon.json) -> reports stopped
  it("status: no daemon.json -> { state: 'stopped' }", async () => {
    const deps = mockDeps({
      exists: vi.fn(() => false),
    });

    const status = await getDaemonStatus(deps);
    expect(status.state).toBe("stopped");
  });

  // Test 9: status stale (daemon.json exists, process dead) -> reports stale, cleans up
  it("status: stale (daemon.json exists, pid dead) -> { state: 'stale' }, cleans up", async () => {
    const state: DaemonState = { pid: 888, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => false),
    });

    const status = await getDaemonStatus(deps);
    expect(status.state).toBe("stale");
    expect(deps.removeFile).toHaveBeenCalledWith(STATE_FILE);
  });

  // Test 10: start --port flag stored in daemon.json and forwarded to env
  it("start: custom port stored in daemon.json and forwarded to spawn env", async () => {
    const deps = mockDeps();
    await startDaemon({ port: 9999 }, deps);

    const state = writtenState(deps);
    expect(state.port).toBe(9999);

    const spawnMock = deps.spawn as ReturnType<typeof vi.fn>;
    const env = spawnMock.mock.calls[0]![2].env;
    expect(env.RIGGED_PORT).toBe("9999");
  });

  // Test 11: start invoked from different cwd -> still resolves correct daemon path
  it("getDaemonPath is stable regardless of cwd", () => {
    const path1 = getDaemonPath();
    // Simulate different cwd by just proving the path is absolute and based on import.meta
    // (cwd doesn't affect path.resolve from import.meta.dirname)
    expect(path.isAbsolute(path1)).toBe(true);
    expect(path1).toContain("daemon");
  });

  // Test 12: logs reads daemon.log content
  it("readLogs: returns daemon.log content when file exists", () => {
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === LOG_FILE),
      readFile: vi.fn((p: string) => {
        if (p === LOG_FILE) return "line1\nline2\n";
        return null;
      }),
    });

    const content = readLogs(deps);
    expect(content).toBe("line1\nline2\n");
  });

  // Test 13: logs no log file -> returns null
  it("readLogs: no log file -> returns null", () => {
    const deps = mockDeps({
      exists: vi.fn(() => false),
    });

    const content = readLogs(deps);
    expect(content).toBeNull();
  });

  // Test 14: CLI delegation: daemon status command uses injected deps
  it("daemonCommand(deps) status calls getDaemonStatus with injected deps", async () => {
    const { daemonCommand } = await import("../src/commands/daemon.js");
    const { Command } = await import("commander");

    const deps = mockDeps({
      exists: vi.fn(() => false), // no daemon.json -> stopped
    });

    const program = new Command();
    program.addCommand(daemonCommand(deps));

    // Capture console output
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await program.parseAsync(["node", "rigged", "daemon", "status"]);
    } finally {
      console.log = origLog;
    }

    // deps.exists was called (proving delegation happened through injected deps)
    expect(deps.exists).toHaveBeenCalled();
    // Output should reflect stopped status
    expect(logs.join("\n")).toMatch(/stopped/i);
  });

  // Test 15: start creates ~/.rigged directory if missing
  it("start: creates RIGGED_DIR if missing", async () => {
    const deps = mockDeps();
    await startDaemon({ port: 7433 }, deps);

    expect(deps.mkdirp).toHaveBeenCalledWith(RIGGED_DIR);
  });

  // Test 16: logs --follow passes follow flag to tailLogs
  it("tailLogs: called with follow=true invokes follow behavior", () => {
    const spawnFn = vi.fn(() => ({ pid: 1, unref: vi.fn(), on: vi.fn() }) as unknown as ChildProcess);
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === LOG_FILE),
      spawn: spawnFn,
    });

    tailLogs(deps, { follow: true });

    // Should spawn tail -f on the log file
    expect(spawnFn).toHaveBeenCalledOnce();
    const [cmd, args] = spawnFn.mock.calls[0]!;
    expect(cmd).toBe("tail");
    expect(args).toContain("-f");
    expect(args).toContain(LOG_FILE);
  });

  // Test 17: pid alive + healthz failure -> running with healthy=false, daemon.json preserved
  it("status: pid alive but healthz fails -> running, healthy=false, state preserved", async () => {
    const state: DaemonState = { pid: 999, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
      fetch: vi.fn(async () => { throw new Error("connection refused"); }),
    });

    const status = await getDaemonStatus(deps);
    expect(status.state).toBe("running");
    expect(status.healthy).toBe(false);
    expect(status.pid).toBe(999);
    expect(status.port).toBe(7433);
    // daemon.json must NOT be deleted — stop still needs the pid
    expect(deps.removeFile).not.toHaveBeenCalled();
  });

  // Test 18: stop with process that won't die -> throws, daemon.json preserved
  it("stop: process survives SIGTERM -> throws, daemon.json NOT removed", async () => {
    const state: DaemonState = { pid: 111, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => true), // never dies
    });

    await expect(stopDaemon(deps)).rejects.toThrow(/did not exit/i);
    expect(deps.kill).toHaveBeenCalledWith(111, "SIGTERM");
    // daemon.json must NOT be deleted — process is still running
    expect(deps.removeFile).not.toHaveBeenCalled();
  });

  // Test 19: start with stale PID (pid alive but healthz fails) -> allows start (PID reuse safety)
  it("start: stale PID (alive but not rigged) -> proceeds to start new daemon", async () => {
    const state: DaemonState = { pid: 999, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    let fetchCount = 0;
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
      // First fetch (verify existing PID): fails -> stale PID
      // Subsequent fetches (healthz poll for new daemon): succeed
      fetch: vi.fn(async () => {
        fetchCount++;
        if (fetchCount === 1) throw new Error("connection refused");
        return { ok: true };
      }),
    });

    const result = await startDaemon({ port: 7433 }, deps);
    expect(result.pid).toBe(12345); // new daemon spawned
  });

  // Test 20: stop with stale PID (alive but not rigged) -> cleans up state, no SIGTERM
  it("stop: stale PID (alive but not rigged) -> removes state, does not kill", async () => {
    const state: DaemonState = { pid: 999, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
      fetch: vi.fn(async () => { throw new Error("connection refused"); }),
    });

    await stopDaemon(deps);
    expect(deps.kill).not.toHaveBeenCalled();
    expect(deps.removeFile).toHaveBeenCalledWith(STATE_FILE);
  });

  // Test 21: malformed daemon.json -> treated as stopped, no crash
  it("malformed daemon.json -> getDaemonStatus returns stopped", async () => {
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return "NOT VALID JSON {{{";
        return null;
      }),
    });

    const status = await getDaemonStatus(deps);
    expect(status.state).toBe("stopped");
  });

  // Test 22: malformed daemon.json -> startDaemon proceeds (treats as no state)
  it("malformed daemon.json -> startDaemon proceeds normally", async () => {
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return "GARBAGE";
        return null;
      }),
    });

    const result = await startDaemon({ port: 7433 }, deps);
    expect(result.pid).toBe(12345);
  });

  // Test 23: start with unhealthy rigged daemon (healthz responds non-ok) -> blocks start
  it("start: unhealthy rigged daemon (healthz responds) -> throws already running", async () => {
    const state: DaemonState = { pid: 999, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
      // healthz responds (even if not ok) → port is ours → rigged
      fetch: vi.fn(async () => ({ ok: false })),
    });

    await expect(startDaemon({ port: 7433 }, deps)).rejects.toThrow(/already running/i);
  });

  // Test 24: stop with unhealthy rigged daemon -> still sends SIGTERM (it's our process)
  it("stop: unhealthy rigged daemon -> sends SIGTERM", async () => {
    const state: DaemonState = { pid: 999, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn()
        .mockReturnValueOnce(true)  // checkPid: alive
        .mockReturnValueOnce(false), // after kill: dead
      // healthz responds (non-ok) → still rigged
      fetch: vi.fn(async () => ({ ok: false })),
    });

    await stopDaemon(deps);
    expect(deps.kill).toHaveBeenCalledWith(999, "SIGTERM");
    expect(deps.removeFile).toHaveBeenCalledWith(STATE_FILE);
  });
});
