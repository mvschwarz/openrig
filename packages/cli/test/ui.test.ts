import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { uiCommand, type UiDeps } from "../src/commands/ui.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";

function mockLifecycleDeps(overrides?: Partial<LifecycleDeps>): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
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

function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try { await fn(); } finally {
      console.log = origLog;
      console.error = origErr;
    }
    resolve(logs);
  });
}

function runningState(port: number): DaemonState {
  return { pid: 123, port, db: "test.sqlite", startedAt: "2026-03-24T00:00:00Z" };
}

function runningDeps(port: number, execFn?: UiDeps["exec"]): UiDeps {
  return {
    lifecycleDeps: mockLifecycleDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(runningState(port));
        return null;
      }),
      fetch: vi.fn(async () => ({ ok: true })),
    }),
    exec: execFn ?? vi.fn(async () => {}),
  };
}

describe("rig ui open", () => {
  // Test 1: Daemon up -> exec open with UI URL AND prints URL
  it("daemon up -> exec open with UI URL and prints URL", async () => {
    const execFn = vi.fn(async () => {});
    const deps = runningDeps(8888, execFn);
    const program = new Command();
    program.addCommand(uiCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "ui", "open"]));

    expect(execFn).toHaveBeenCalledWith("open", ["http://127.0.0.1:5173"]);
    expect(logs.join("\n")).toContain("http://127.0.0.1:5173");
  });

  // Test 2: Daemon down -> error, no exec
  it("daemon down -> error, no exec", async () => {
    const execFn = vi.fn(async () => {});
    const deps: UiDeps = {
      lifecycleDeps: mockLifecycleDeps({ exists: vi.fn(() => false) }),
      exec: execFn,
    };
    const program = new Command();
    program.addCommand(uiCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "ui", "open"]));

    expect(logs.join("\n")).toMatch(/not running/i);
    expect(execFn).not.toHaveBeenCalled();
  });

  // Test 3: UI URL is stable even when daemon runs on another port
  it("UI URL does not change with daemon port", async () => {
    const execFn = vi.fn(async () => {});
    const deps = runningDeps(9999, execFn);
    const program = new Command();
    program.addCommand(uiCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "ui", "open"]));

    expect(execFn).toHaveBeenCalledWith("open", ["http://127.0.0.1:5173"]);
    expect(logs.join("\n")).toContain("http://127.0.0.1:5173");
  });

  // Test 4: Unhealthy daemon -> error, no exec
  it("unhealthy daemon -> error, no exec", async () => {
    const execFn = vi.fn(async () => {});
    const deps: UiDeps = {
      lifecycleDeps: mockLifecycleDeps({
        exists: vi.fn((p: string) => p === STATE_FILE),
        readFile: vi.fn((p: string) => {
          if (p === STATE_FILE) return JSON.stringify(runningState(7433));
          return null;
        }),
        isProcessAlive: vi.fn(() => true),
        fetch: vi.fn(async () => { throw new Error("refused"); }),
      }),
      exec: execFn,
    };
    const program = new Command();
    program.addCommand(uiCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "ui", "open"]));

    expect(logs.join("\n")).toMatch(/unhealthy/i);
    expect(execFn).not.toHaveBeenCalled();
  });

  // Test 5: createProgram: rig ui open mounted
  it("rig ui open is wired via createProgram", async () => {
    const { createProgram } = await import("../src/index.js");
    const execFn = vi.fn(async () => {});
    const deps: UiDeps = {
      lifecycleDeps: mockLifecycleDeps({ exists: vi.fn(() => false) }),
      exec: execFn,
    };
    const program = createProgram({ uiDeps: deps });
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "ui", "open"]));
    expect(logs.join("\n")).toMatch(/not running/i);
  });

  // Test 6: open exec fails -> UI URL still printed, clean error, non-zero exit
  it("open exec fails -> UI URL still printed + clean error + exitCode 1", async () => {
    const execFn = vi.fn(async () => { throw new Error("no browser"); });
    const deps = runningDeps(7433, execFn);
    const program = new Command();
    program.addCommand(uiCommand(deps));

    const savedExitCode = process.exitCode;
    process.exitCode = undefined;

    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "ui", "open"]));

    const output = logs.join("\n");
    // URL must be printed even when open fails
    expect(output).toContain("http://127.0.0.1:5173");
    // Clean error message
    expect(output).toMatch(/failed to open|manually/i);
    // Non-zero exit code
    expect(process.exitCode).toBe(1);

    process.exitCode = savedExitCode;
  });

  // Test 7: Print always: even on success, URL is in output
  it("UI URL is always printed even on successful open", async () => {
    const execFn = vi.fn(async () => {});
    const deps = runningDeps(5555, execFn);
    const program = new Command();
    program.addCommand(uiCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "ui", "open"]));

    expect(logs.join("\n")).toContain("http://127.0.0.1:5173");
    expect(execFn).toHaveBeenCalled();
  });
});
