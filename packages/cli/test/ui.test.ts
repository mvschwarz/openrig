import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

  // Test 4: a busy daemon (process alive, health check failing) -> the UI URL still opens.
  // Changed: this used to refuse. A busy daemon is not refused; the browser shows what it serves.
  it("busy daemon -> opens the UI URL", async () => {
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
      probeUi: async () => new Response("", { status: 200 }),
    };
    const program = new Command();
    program.addCommand(uiCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "ui", "open"]));

    expect(execFn).toHaveBeenCalledWith("open", ["http://127.0.0.1:7433"]);
    expect(logs.join("\n")).not.toMatch(/did not respond/i);
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

// The web UI takes its tokens from its address's fragment (#termToken=…&mcToken=…), which a browser never sends. `rig ui
// open` gives it the tokens this CLI itself sends to the daemon. Every token here is synthetic.
describe("rig ui open on a daemon with tokens", () => {
  const ENV_KEYS = ["OPENRIG_TERMINAL_BEARER_TOKEN", "OPENRIG_AUTH_BEARER_TOKEN", "OPENRIG_HOME", "OPENRIG_UI_URL"] as const;
  type EnvKey = (typeof ENV_KEYS)[number];

  async function openWith(env: Partial<Record<EnvKey, string>>, opts: { terminalTokenFile?: string; probeUi?: UiDeps["probeUi"] } = {}) {
    const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<EnvKey, string | undefined>;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rig-ui-open-"));
    if (opts.terminalTokenFile !== undefined) fs.writeFileSync(path.join(home, "terminal-token"), opts.terminalTokenFile);
    for (const key of ENV_KEYS) delete process.env[key];
    process.env["OPENRIG_HOME"] = home;
    Object.assign(process.env, env);
    const priorExitCode = process.exitCode;
    try {
      const execFn = vi.fn(async (_cmd: string, _args: string[]) => {});
      const deps = runningDeps(8888, execFn);
      if (opts.probeUi) deps.probeUi = opts.probeUi;
      const program = new Command();
      program.addCommand(uiCommand(deps));
      const logs = await captureLogs(() => program.parseAsync(["node", "rig", "ui", "open"]).then(() => undefined));
      return { execFn, output: logs.join("\n"), exitCode: process.exitCode };
    } finally {
      process.exitCode = priorExitCode;
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  /** What the UI's primer takes from an address: the fragment split on `&`, each value URI-decoded. */
  function fragmentTokens(address: string): Record<string, string> {
    const at = address.indexOf("#");
    if (at < 0) return {};
    return Object.fromEntries(address.slice(at + 1).split("&").map((part) => {
      const eq = part.indexOf("=");
      return [part.slice(0, eq), decodeURIComponent(part.slice(eq + 1))];
    }));
  }

  it("opens the UI with this CLI's terminal and operator tokens in the fragment, and prints the address without them", async () => {
    const terminal = "synthetic-term+/=&#token";
    const operator = "synthetic-operator token";
    const { execFn, output } = await openWith({ OPENRIG_TERMINAL_BEARER_TOKEN: terminal, OPENRIG_AUTH_BEARER_TOKEN: operator });

    expect(execFn).toHaveBeenCalledTimes(1);
    const [command, [opened]] = execFn.mock.calls[0]!;
    expect(command).toBe("open");
    expect(opened.startsWith("http://127.0.0.1:8888#")).toBe(true);
    expect(fragmentTokens(opened)).toEqual({ termToken: terminal, mcToken: operator });
    expect(output).toContain("http://127.0.0.1:8888");
    expect(output).not.toContain("synthetic");
  });

  it("takes the terminal token from $OPENRIG_HOME/terminal-token when the environment has none, as the CLI's own requests do", async () => {
    const { execFn, output } = await openWith({}, { terminalTokenFile: "synthetic-file-token\n" });

    const [, [opened]] = execFn.mock.calls[0]!;
    // With no operator token set, the CLI's operator requests send the terminal token; the UI gets the same.
    expect(fragmentTokens(opened)).toEqual({ termToken: "synthetic-file-token", mcToken: "synthetic-file-token" });
    expect(output).not.toContain("synthetic");
  });

  it("opens a tokenless daemon's UI at its plain address", async () => {
    const { execFn } = await openWith({});
    expect(execFn).toHaveBeenCalledWith("open", ["http://127.0.0.1:8888"]);
  });

  it("opens an explicit OPENRIG_UI_URL as given, with no tokens added", async () => {
    const { execFn } = await openWith({
      OPENRIG_UI_URL: "http://localhost:5173",
      OPENRIG_TERMINAL_BEARER_TOKEN: "synthetic-term",
      OPENRIG_AUTH_BEARER_TOKEN: "synthetic-operator",
    });
    expect(execFn).toHaveBeenCalledWith("open", ["http://localhost:5173"]);
  });

  it("a daemon with the UI off opens nothing and prints no token", async () => {
    const { execFn, output, exitCode } = await openWith(
      { OPENRIG_TERMINAL_BEARER_TOKEN: "synthetic-term", OPENRIG_AUTH_BEARER_TOKEN: "synthetic-operator" },
      { probeUi: vi.fn(async () => ({ status: 404, headers: new Headers({ "x-openrig-web-ui": "off" }) })) },
    );
    expect(execFn).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
    expect(output).toContain(UI_DISABLED_GUIDANCE);
    expect(output).not.toContain("synthetic");
  });
});
