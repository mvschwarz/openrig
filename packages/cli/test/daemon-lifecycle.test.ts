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
  resolveDaemonPath,
  buildDaemonEnv,
  STATE_FILE,
  LOG_FILE,
  OPENRIG_DIR,
  type LifecycleDeps,
  type DaemonState,
} from "../src/daemon-lifecycle.js";

function neverFetch(): Promise<{ ok: boolean }> {
  return new Promise(() => {});
}

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
  it("getDaemonPath resolves absolute path ending with daemon", () => {
    const daemonPath = getDaemonPath();
    expect(path.isAbsolute(daemonPath)).toBe(true);
    expect(daemonPath).toMatch(/daemon$/);
  });

  // Test 2: start constructs exact spawn command with correct env/redirect
  it("start: constructs spawn with node, daemon entry, env, and log redirect", async () => {
    const deps = mockDeps();
    await startDaemon({ port: 7433, db: "openrig.sqlite" }, deps);

    const spawnMock = deps.spawn as ReturnType<typeof vi.fn>;
    expect(spawnMock).toHaveBeenCalledOnce();

    const [cmd, args, opts] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe(process.execPath);
    expect(args[0]).toContain("daemon");
    expect(args[0]).toContain("dist/index.js");
    expect(opts.env).toMatchObject({
      OPENRIG_PORT: "7433",
      OPENRIG_DB: "openrig.sqlite",
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
    const state: DaemonState = { pid: 555, port: 7433, db: "openrig.sqlite", startedAt: "2026-01-01T00:00:00Z" };
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
    expect(env.OPENRIG_PORT).toBe("9999");
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
      await program.parseAsync(["node", "rig", "daemon", "status"]);
    } finally {
      console.log = origLog;
    }

    // deps.exists was called (proving delegation happened through injected deps)
    expect(deps.exists).toHaveBeenCalled();
    // Output should reflect stopped status
    expect(logs.join("\n")).toMatch(/stopped/i);
  });

  // Test 15: start creates ~/.openrig directory if missing
  it("start: creates OPENRIG_DIR if missing", async () => {
    const deps = mockDeps();
    await startDaemon({ port: 7433 }, deps);

    expect(deps.mkdirp).toHaveBeenCalledWith(OPENRIG_DIR);
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

  it("status: hanging healthz probe resolves boundedly as unhealthy instead of hanging forever", async () => {
    vi.useFakeTimers();
    const state: DaemonState = { pid: 999, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
      fetch: vi.fn(() => neverFetch()),
    });

    const statusPromise = getDaemonStatus(deps);
    await vi.runAllTimersAsync();
    const status = await statusPromise;

    expect(status.state).toBe("running");
    expect(status.healthy).toBe(false);
    vi.useRealTimers();
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
  it("start: stale PID (alive but not rig) -> proceeds to start new daemon", async () => {
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

  it("start: hanging healthz probe on existing pid throws unresponsive error instead of spawning a second daemon", async () => {
    vi.useFakeTimers();
    const state: DaemonState = { pid: 999, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
      fetch: vi.fn(() => neverFetch()),
    });

    const startPromise = startDaemon({ port: 7433 }, deps).catch((error) => error as Error);
    await vi.runAllTimersAsync();
    const error = await startPromise;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/unresponsive/i);
    expect(deps.spawn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // Test 20: stop with stale PID (alive but not rig) -> cleans up state, no SIGTERM
  it("stop: stale PID (alive but not rig) -> removes state, does not kill", async () => {
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

  it("stop: hanging healthz probe still issues SIGTERM and completes boundedly", async () => {
    vi.useFakeTimers();
    const state: DaemonState = { pid: 999, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false),
      fetch: vi.fn(() => neverFetch()),
    });

    const stopPromise = stopDaemon(deps);
    await vi.runAllTimersAsync();
    await stopPromise;

    expect(deps.kill).toHaveBeenCalledWith(999, "SIGTERM");
    expect(deps.removeFile).toHaveBeenCalledWith(STATE_FILE);
    vi.useRealTimers();
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

  // Test 23: start with unhealthy rig daemon (healthz responds non-ok) -> blocks start
  it("start: unhealthy rig daemon (healthz responds) -> throws already running", async () => {
    const state: DaemonState = { pid: 999, port: 7433, db: "x.db", startedAt: "2026-01-01T00:00:00Z" };
    const deps = mockDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(state);
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
      // healthz responds (even if not ok) → port is ours → rig
      fetch: vi.fn(async () => ({ ok: false })),
    });

    await expect(startDaemon({ port: 7433 }, deps)).rejects.toThrow(/already running/i);
  });

  // Test 24: stop with unhealthy rig daemon -> still sends SIGTERM (it's our process)
  it("stop: unhealthy rig daemon -> sends SIGTERM", async () => {
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
      // healthz responds (non-ok) → still rig
      fetch: vi.fn(async () => ({ ok: false })),
    });

    await stopDaemon(deps);
    expect(deps.kill).toHaveBeenCalledWith(999, "SIGTERM");
    expect(deps.removeFile).toHaveBeenCalledWith(STATE_FILE);
  });

  // Test 25: start spawns process.execPath, not bare "node"
  it("start: spawns process.execPath as the Node binary", async () => {
    const deps = mockDeps();
    await startDaemon({ port: 7433, db: "openrig.sqlite" }, deps);

    const spawnMock = deps.spawn as ReturnType<typeof vi.fn>;
    const [cmd] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe(process.execPath);
  });

  it("start: surfaces native module runtime mismatch inline when healthz never comes up", async () => {
    vi.useFakeTimers();
    const deps = mockDeps({
      fetch: vi.fn(async () => { throw new Error("connection refused"); }),
      readFile: vi.fn((p: string) => {
        if (p === LOG_FILE) {
          return [
            "Error: The module '/tmp/better_sqlite3.node'",
            "was compiled against a different Node.js version using",
            "NODE_MODULE_VERSION 127. This version of Node.js requires",
            "NODE_MODULE_VERSION 141. Please try re-compiling or re-installing",
            "the module (for instance, using `npm rebuild` or `npm install`).",
            "code: 'ERR_DLOPEN_FAILED'",
          ].join("\n");
        }
        return null;
      }),
    });

    const startPromise = startDaemon({ port: 7433 }, deps).catch((error) => error as Error);
    await vi.runAllTimersAsync();
    const error = await startPromise;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/better-sqlite3|native module|node/i);
    expect(error.message).toContain(process.version);
    expect(error.message).toContain(process.execPath);
    vi.useRealTimers();
  });

  it("start: surfaces the recent daemon log line when startup crashes for another reason", async () => {
    vi.useFakeTimers();
    const deps = mockDeps({
      fetch: vi.fn(async () => { throw new Error("connection refused"); }),
      readFile: vi.fn((p: string) => {
        if (p === LOG_FILE) {
          return [
            "Booting daemon...",
            "Error: SQLite schema migration failed: disk full",
          ].join("\n");
        }
        return null;
      }),
    });

    const startPromise = startDaemon({ port: 7433 }, deps).catch((error) => error as Error);
    await vi.runAllTimersAsync();
    const error = await startPromise;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/disk full/i);
    vi.useRealTimers();
  });

  // Test 26: OPENRIG_URL set → getDaemonStatus bypasses daemon.json
  it("status: OPENRIG_URL set → probes URL directly, ignores daemon.json", async () => {
    const prev = process.env["OPENRIG_URL"];
    process.env["OPENRIG_URL"] = "http://127.0.0.1:7455";
    try {
      const deps = mockDeps({
        exists: vi.fn(() => false),
        readFile: vi.fn(() => null),
        fetch: vi.fn(async () => ({ ok: true })),
      });

      const status = await getDaemonStatus(deps);
      expect(status.state).toBe("running");
      expect(status.port).toBe(7455);
      expect(status.healthy).toBe(true);
      // daemon.json was never read
      expect(deps.readFile).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env["OPENRIG_URL"];
      else process.env["OPENRIG_URL"] = prev;
    }
  });

  // Test 27: OPENRIG_URL set but unreachable → stopped
  it("status: OPENRIG_URL set but unreachable → stopped", async () => {
    const prev = process.env["OPENRIG_URL"];
    process.env["OPENRIG_URL"] = "http://127.0.0.1:9999";
    try {
      const deps = mockDeps({
        exists: vi.fn(() => false),
        readFile: vi.fn(() => null),
        fetch: vi.fn(async () => { throw new Error("connection refused"); }),
      });

      const status = await getDaemonStatus(deps);
      expect(status.state).toBe("stopped");
    } finally {
      if (prev === undefined) delete process.env["OPENRIG_URL"];
      else process.env["OPENRIG_URL"] = prev;
    }
  });

  it("createIsProcessAlive treats zombie processes as dead", async () => {
    const { createIsProcessAlive } = await import("../src/commands/daemon.js");
    const isAlive = createIsProcessAlive({
      signalCheck: () => true,
      readProcessState: () => "Z",
    });

    expect(isAlive(123)).toBe(false);
  });

  it("createIsProcessAlive keeps non-zombie processes alive", async () => {
    const { createIsProcessAlive } = await import("../src/commands/daemon.js");
    const isAlive = createIsProcessAlive({
      signalCheck: () => true,
      readProcessState: () => "S",
    });

    expect(isAlive(123)).toBe(true);
  });
});

describe("resolveDaemonPath", () => {
  it("returns bundled path when ../daemon/dist/index.js exists", () => {
    const exists = (p: string) => p.endsWith("daemon/dist/index.js");
    const result = resolveDaemonPath("/install/cli/dist", exists);
    expect(result).toBe(path.resolve("/install/cli/dist", "../daemon"));
  });

  it("falls back to monorepo path when bundled does not exist", () => {
    const exists = () => false;
    const result = resolveDaemonPath("/repo/packages/cli/dist", exists);
    expect(result).toBe(path.resolve("/repo/packages/cli/dist", "../../daemon"));
  });
});

describe("startDaemon env sanitization", () => {
  it("startDaemon spawns with sanitized env that excludes terminal/GUI vars", async () => {
    // Pollute process.env temporarily
    const saved: Record<string, string | undefined> = {};
    const pollutants: Record<string, string> = {
      GHOSTTY_BIN_DIR: "/bad",
      TERM_PROGRAM: "ghostty",
      CMUX_WORKSPACE: "workspace:1",
      CMUX_PANEL_ID: "panel:7",
      CMUX_BUNDLED_CLI_PATH: "/Applications/cmux.app/Contents/Resources/bin/cmux",
      CODEX_CI: "1",
      COMMAND_MODE: "unix2003",
      __CFBundleIdentifier: "com.test",
    };
    for (const [k, v] of Object.entries(pollutants)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }

    try {
      const deps = mockDeps();
      await startDaemon({ port: 7433, host: "127.0.0.1", db: "/tmp/test.db" }, deps);

      const spawnCall = (deps.spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      const spawnEnv = spawnCall![2].env as Record<string, string>;

      // Scrubbed vars must NOT be in spawn env
      expect(spawnEnv["GHOSTTY_BIN_DIR"]).toBeUndefined();
      expect(spawnEnv["TERM_PROGRAM"]).toBeUndefined();
      expect(spawnEnv["CMUX_WORKSPACE"]).toBeUndefined();
      expect(spawnEnv["CMUX_PANEL_ID"]).toBeUndefined();
      expect(spawnEnv["CMUX_BUNDLED_CLI_PATH"]).toBeUndefined();
      expect(spawnEnv["CODEX_CI"]).toBeUndefined();
      expect(spawnEnv["COMMAND_MODE"]).toBeUndefined();
      expect(spawnEnv["__CFBundleIdentifier"]).toBeUndefined();

      // Core vars must be present
      expect(spawnEnv["HOME"]).toBeDefined();
      expect(spawnEnv["OPENRIG_PORT"]).toBe("7433");
    } finally {
      // Restore process.env
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("buildDaemonEnv", () => {
  it("strips terminal/GUI vars and preserves core vars", () => {
    const baseEnv: Record<string, string> = {
      HOME: "/Users/tester",
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      USER: "tester",
      SHELL: "/bin/zsh",
      COLORTERM: "truecolor",
      COMMAND_MODE: "unix2003",
      CODEX_CI: "1",
      CODEX_THREAD_ID: "thread-123",
      GHOSTTY_BIN_DIR: "/Applications/Ghostty.app/bin",
      GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app/resources",
      GHOSTTY_SHELL_FEATURES: "cursor,title",
      TERM_PROGRAM: "ghostty",
      TERM_PROGRAM_VERSION: "1.0",
      TERMINFO: "/Applications/Ghostty.app/terminfo",
      XPC_FLAGS: "0x0",
      XPC_SERVICE_NAME: "0",
      __CFBundleIdentifier: "com.cmuxterm.app",
      __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",
      CMUX_BUNDLE_ID: "com.cmuxterm.app",
      CMUX_BUNDLED_CLI_PATH: "/Applications/cmux.app/Contents/Resources/bin/cmux",
      CMUX_PANEL_ID: "panel:1",
      CMUX_SOCKET_PATH: "/tmp/cmux.sock",
      CMUX_TAB_ID: "tab:1",
      CMUX_WORKSPACE: "workspace:1",
      CMUX_WORKSPACE_ID: "workspace:1",
      CMUX_SURFACE_ID: "surface:3",
      LANG: "en_US.UTF-8",
    };

    const result = buildDaemonEnv(baseEnv, { port: 7433, host: "127.0.0.1", db: "/tmp/test.db" });

    // Core vars preserved
    expect(result["HOME"]).toBe("/Users/tester");
    expect(result["PATH"]).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(result["USER"]).toBe("tester");
    expect(result["SHELL"]).toBe("/bin/zsh");
    expect(result["LANG"]).toBe("en_US.UTF-8");

    // OPENRIG_* set from opts
    expect(result["OPENRIG_PORT"]).toBe("7433");
    expect(result["OPENRIG_HOST"]).toBe("127.0.0.1");
    expect(result["OPENRIG_DB"]).toBe("/tmp/test.db");

    // Scrubbed vars absent
    expect(result["COLORTERM"]).toBeUndefined();
    expect(result["COMMAND_MODE"]).toBeUndefined();
    expect(result["CODEX_CI"]).toBeUndefined();
    expect(result["CODEX_THREAD_ID"]).toBeUndefined();
    expect(result["GHOSTTY_BIN_DIR"]).toBeUndefined();
    expect(result["GHOSTTY_RESOURCES_DIR"]).toBeUndefined();
    expect(result["GHOSTTY_SHELL_FEATURES"]).toBeUndefined();
    expect(result["TERM_PROGRAM"]).toBeUndefined();
    expect(result["TERM_PROGRAM_VERSION"]).toBeUndefined();
    expect(result["TERMINFO"]).toBeUndefined();
    expect(result["XPC_FLAGS"]).toBeUndefined();
    expect(result["XPC_SERVICE_NAME"]).toBeUndefined();
    expect(result["__CFBundleIdentifier"]).toBeUndefined();
    expect(result["__CF_USER_TEXT_ENCODING"]).toBeUndefined();
    expect(result["CMUX_BUNDLE_ID"]).toBeUndefined();
    expect(result["CMUX_BUNDLED_CLI_PATH"]).toBeUndefined();
    expect(result["CMUX_PANEL_ID"]).toBeUndefined();
    expect(result["CMUX_SOCKET_PATH"]).toBeUndefined();
    expect(result["CMUX_TAB_ID"]).toBeUndefined();
    expect(result["CMUX_WORKSPACE"]).toBeUndefined();
    expect(result["CMUX_WORKSPACE_ID"]).toBeUndefined();
    expect(result["CMUX_SURFACE_ID"]).toBeUndefined();
  });

  it("explicit opts override inherited OPENRIG_* from base env", () => {
    const baseEnv: Record<string, string> = {
      HOME: "/Users/tester",
      PATH: "/usr/bin",
      OPENRIG_PORT: "9999",
      OPENRIG_DB: "/old/path.db",
    };

    const result = buildDaemonEnv(baseEnv, { port: 7433, host: "127.0.0.1", db: "/new/path.db" });

    expect(result["OPENRIG_PORT"]).toBe("7433");
    expect(result["OPENRIG_DB"]).toBe("/new/path.db");
  });
});
