import { describe, it, expect, vi } from "vitest";
import { createProgram } from "../src/index.js";
import { Command } from "commander";
import {
  UI_DISABLED_GUIDANCE,
  UI_MAINTENANCE_NOTICE,
  uiCommand,
  type UiDeps,
} from "../src/commands/ui.js";
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
    // The daemon serves the UI unless a test says otherwise; no test reaches a real port.
    probeUi: vi.fn(async () => ({ status: 200, headers: new Headers({ "content-type": "text/html" }) })),
  };
}

describe("rig ui open", () => {
  it("prints the maintenance notice to stderr on every invocation", async () => {
    expect(UI_MAINTENANCE_NOTICE).toBe(
      "The OpenRig UI is experimental and in maintenance mode. It is not under active development; support is best-effort. The CLI is the primary supported interface. Contributions welcome.",
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const execFn = vi.fn(async () => {});
    const deps = runningDeps(8888, execFn);

    for (let invocation = 0; invocation < 2; invocation += 1) {
      const program = new Command();
      program.addCommand(uiCommand(deps));
      await program.parseAsync(["node", "rig", "ui", "open"]);
    }

    expect(error.mock.calls.filter(([line]) => line === UI_MAINTENANCE_NOTICE)).toHaveLength(2);
    error.mockRestore();
  });

  // Test 1: Daemon up -> exec open with UI URL AND prints URL
  it("daemon up -> exec open with UI URL and prints URL", async () => {
    const execFn = vi.fn(async () => {});
    const deps = runningDeps(8888, execFn);
    const program = new Command();
    program.addCommand(uiCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "ui", "open"]));

    expect(execFn).toHaveBeenCalledWith("open", ["http://127.0.0.1:8888"]);
    expect(logs.join("\n")).toContain("http://127.0.0.1:8888");
  });

  // Test 2: Daemon down -> error, no exec
  it("daemon down -> error, no exec", async () => {
    const execFn = vi.fn(async () => {});
    const deps: UiDeps = {
      lifecycleDeps: mockLifecycleDeps({
        exists: vi.fn(() => false),
        fetch: vi.fn(async () => { throw new Error("refused"); }),
      }),
      exec: execFn,
    };
    const program = new Command();
    program.addCommand(uiCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "ui", "open"]));

    expect(logs.join("\n")).toMatch(/not running/i);
    expect(execFn).not.toHaveBeenCalled();
  });

  it("no daemon.json but configured daemon is healthy -> opens recovered daemon URL", async () => {
    const savedPort = process.env["OPENRIG_PORT"];
    const savedHost = process.env["OPENRIG_HOST"];
    process.env["OPENRIG_PORT"] = "7555";
    process.env["OPENRIG_HOST"] = "127.0.0.1";
    try {
      const execFn = vi.fn(async () => {});
      const deps: UiDeps = {
        lifecycleDeps: mockLifecycleDeps({
          exists: vi.fn(() => false),
          fetch: vi.fn(async (url: string) => {
            expect(url).toBe("http://127.0.0.1:7555/healthz");
            return { ok: true };
          }),
        }),
        exec: execFn,
      };
      const program = new Command();
      program.addCommand(uiCommand(deps));
      const logs = await captureLogs(() => program.parseAsync(["node", "rig", "ui", "open"]));

      expect(execFn).toHaveBeenCalledWith("open", ["http://127.0.0.1:7555"]);
      expect(logs.join("\n")).toContain("http://127.0.0.1:7555");
      expect(logs.join("\n")).not.toMatch(/not running/i);
    } finally {
      if (savedPort === undefined) delete process.env["OPENRIG_PORT"];
      else process.env["OPENRIG_PORT"] = savedPort;
      if (savedHost === undefined) delete process.env["OPENRIG_HOST"];
      else process.env["OPENRIG_HOST"] = savedHost;
    }
  });

  // Test 3: UI URL derives from daemon port (daemon serves the UI)
  it("UI URL derives from daemon port", async () => {
    const execFn = vi.fn(async () => {});
    const deps = runningDeps(9999, execFn);
    const program = new Command();
    program.addCommand(uiCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "ui", "open"]));

    expect(execFn).toHaveBeenCalledWith("open", ["http://127.0.0.1:9999"]);
    expect(logs.join("\n")).toContain("http://127.0.0.1:9999");
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

    expect(logs.join("\n")).toMatch(/did not respond|busy or stopped|unhealthy/i) // B8 supersession: epistemic guard language;
    expect(execFn).not.toHaveBeenCalled();
  });

  // Test 5: createProgram: rig ui open mounted
  it("rig ui open is wired via createProgram", async () => {
    const execFn = vi.fn(async () => {});
    const deps: UiDeps = {
      lifecycleDeps: mockLifecycleDeps({
        exists: vi.fn(() => false),
        fetch: vi.fn(async () => { throw new Error("refused"); }),
      }),
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
    expect(output).toContain("http://127.0.0.1:7433");
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

    expect(logs.join("\n")).toContain("http://127.0.0.1:5555");
    expect(execFn).toHaveBeenCalled();
  });

  // Test 8: OPENRIG_UI_URL override works even when daemon is stopped
  it("OPENRIG_UI_URL override works without daemon running", async () => {
    const prev = process.env["OPENRIG_UI_URL"];
    process.env["OPENRIG_UI_URL"] = "http://localhost:5173";
    try {
      const execFn = vi.fn(async () => {});
      // Daemon is down (no state file)
      const deps: UiDeps = {
        lifecycleDeps: mockLifecycleDeps({ exists: vi.fn(() => false) }),
        exec: execFn,
      };
      const program = new Command();
      program.addCommand(uiCommand(deps));
      const logs = await captureLogs(() => program.parseAsync(["node", "rig", "ui", "open"]));

      expect(execFn).toHaveBeenCalledWith("open", ["http://localhost:5173"]);
      expect(logs.join("\n")).toContain("http://localhost:5173");
      // Should NOT see "not running" error
      expect(logs.join("\n")).not.toMatch(/not running/i);
    } finally {
      if (prev === undefined) delete process.env["OPENRIG_UI_URL"];
      else process.env["OPENRIG_UI_URL"] = prev;
    }
  });

  it("daemon serving the UI off -> prints the enable and restart steps, exits 1, opens nothing", async () => {
    const execFn = vi.fn(async () => {});
    const deps = runningDeps(8888, execFn);
    deps.probeUi = vi.fn(async () => ({ status: 404, headers: new Headers({ "x-openrig-web-ui": "off" }) }));
    const prior = process.exitCode;
    process.exitCode = undefined;
    const program = new Command();
    program.addCommand(uiCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "ui", "open"]).then(() => undefined));
    expect(process.exitCode).toBe(1);
    process.exitCode = prior;
    expect(deps.probeUi).toHaveBeenCalledWith("http://127.0.0.1:8888");
    expect(execFn).not.toHaveBeenCalled();
    expect(logs).toContain(UI_DISABLED_GUIDANCE);
    expect(UI_DISABLED_GUIDANCE).toContain("rig config set ui.enabled true");
    expect(UI_DISABLED_GUIDANCE).toMatch(/rig daemon stop.*rig daemon start/);
    expect(logs).not.toContain("http://127.0.0.1:8888");
  });

  it("an unanswered UI probe opens the URL as before", async () => {
    const execFn = vi.fn(async () => {});
    const deps = runningDeps(8888, execFn);
    deps.probeUi = vi.fn(async () => { throw new Error("connection refused"); });
    const program = new Command();
    program.addCommand(uiCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "ui", "open"]).then(() => undefined));
    expect(execFn).toHaveBeenCalledWith("open", ["http://127.0.0.1:8888"]);
    expect(logs).not.toContain(UI_DISABLED_GUIDANCE);
  });
});
