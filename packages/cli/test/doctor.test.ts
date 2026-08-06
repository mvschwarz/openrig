import { describe, it, expect, vi } from "vitest";
import { createProgram } from "../src/index.js";
import { Command } from "commander";
import { doctorCommand, runDoctorChecks, type DoctorDeps } from "../src/commands/doctor.js";
import { resolveCmuxSettingsPath } from "../src/cmux-config.js";

const CMUX_SETTINGS_PATH = resolveCmuxSettingsPath();

const defaultConfig = {
  daemon: { port: 7433, host: "127.0.0.1" },
  db: { path: "/tmp/openrig/openrig.sqlite" },
  transcripts: { enabled: true, path: "/tmp/openrig/transcripts" },
};

function makeDeps(overrides?: Partial<DoctorDeps>): DoctorDeps {
  return {
    exists: () => true,
    baseDir: "/install/cli/dist",
    readFile: () => null,
    exec: (cmd: string) => {
      if (cmd === "tmux -V") return "tmux 3.4\n";
      if (cmd === "cmux capabilities --json") return '{"capabilities":["surface.focus"]}\n';
      if (cmd === "cmux --help") return "cmux help\n";
      return "";
    },
    checkPort: async () => true,
    configStore: { resolve: () => defaultConfig },
    platform: "darwin",
    mkdirp: () => {},
    checkWritable: () => {},
    ...overrides,
  };
}

describe("runDoctorChecks", () => {
  it("monorepo command-dir base resolves via the same daemon root seam as daemon start", () => {
    const deps = makeDeps({
      baseDir: "/Users/example/code/openrig/packages/cli/src/commands",
      exists: (p) =>
        p === "/Users/example/code/openrig/packages/daemon/dist/index.js"
        || p === "/Users/example/code/openrig/packages/ui/dist/index.html",
    });

    const { checks } = runDoctorChecks(deps);
    expect(checks.find((c) => c.name === "daemon_dist")?.status).toBe("pass");
    expect(checks.find((c) => c.name === "ui_dist")?.status).toBe("pass");
  });

  it("daemon dist found -> pass", () => {
    const deps = makeDeps({ exists: (p) => p.endsWith("dist/index.js") || p.endsWith("index.html") });
    const { checks } = runDoctorChecks(deps);
    const daemonCheck = checks.find((c) => c.name === "daemon_dist");
    expect(daemonCheck?.status).toBe("pass");
  });

  it("daemon dist missing -> fail with guidance", () => {
    const deps = makeDeps({ exists: () => false });
    const { checks } = runDoctorChecks(deps);
    const daemonCheck = checks.find((c) => c.name === "daemon_dist");
    expect(daemonCheck?.status).toBe("fail");
    expect(daemonCheck?.reason).toBeTruthy();
    expect(daemonCheck?.fix).toBeTruthy();
  });

  it("UI dist found -> pass", () => {
    const deps = makeDeps({ exists: (p) => p.endsWith("index.html") || p.endsWith("dist/index.js") });
    const { checks } = runDoctorChecks(deps);
    const uiCheck = checks.find((c) => c.name === "ui_dist");
    expect(uiCheck?.status).toBe("pass");
  });

  it("UI dist missing -> fail with guidance", () => {
    const deps = makeDeps({ exists: (p) => p.endsWith("dist/index.js") }); // daemon exists but not UI
    const { checks } = runDoctorChecks(deps);
    const uiCheck = checks.find((c) => c.name === "ui_dist");
    expect(uiCheck?.status).toBe("fail");
    expect(uiCheck?.reason).toContain("UI");
    expect(uiCheck?.fix).toBeTruthy();
  });

  it("tmux available -> pass", () => {
    const deps = makeDeps({
      exec: (cmd: string) => {
        if (cmd === "tmux -V") return "tmux 3.4\n";
        if (cmd === "tmux list-sessions") return "";
        if (cmd === "tmux show-options -gqv mouse") return "on\n";
        return "";
      },
    });
    const { checks } = runDoctorChecks(deps);
    const tmuxCheck = checks.find((c) => c.name === "tmux");
    expect(tmuxCheck?.status).toBe("pass");
  });

  it("tmux installed but default control socket unhealthy -> fail with attention guidance", () => {
    const deps = makeDeps({
      exec: (cmd: string) => {
        if (cmd === "tmux -V") return "tmux 3.4\n";
        if (cmd === "tmux list-sessions") throw new Error("server exited unexpectedly");
        if (cmd === "cmux capabilities --json") return '{"capabilities":["surface.focus"]}\n';
        if (cmd === "cmux --help") return "cmux help\n";
        return "";
      },
    });

    const { checks } = runDoctorChecks(deps);
    const tmuxCheck = checks.find((c) => c.name === "tmux");

    expect(tmuxCheck?.status).toBe("fail");
    expect(tmuxCheck?.message).toContain("control socket");
    expect(tmuxCheck?.reason).toContain("server exited unexpectedly");
    expect(tmuxCheck?.fix).toContain("restart the default tmux server");
  });

  it("tmux mouse enabled on macOS -> pass", () => {
    const deps = makeDeps({
      exec: (cmd: string) => {
        if (cmd === "tmux -V") return "tmux 3.4\n";
        if (cmd === "tmux show-options -gqv mouse") return "on\n";
        if (cmd === "cmux capabilities --json") return '{"capabilities":["surface.focus"]}\n';
        if (cmd === "cmux --help") return "cmux help\n";
        return "";
      },
    });
    const { checks } = runDoctorChecks(deps);
    const mouseCheck = checks.find((c) => c.name === "tmux_mouse");
    expect(mouseCheck?.status).toBe("pass");
    expect(mouseCheck?.message).toContain("enabled");
  });

  it("tmux mouse disabled on macOS -> warn with exact fix", () => {
    const deps = makeDeps({
      exec: (cmd: string) => {
        if (cmd === "tmux -V") return "tmux 3.4\n";
        if (cmd === "tmux show-options -gqv mouse") return "off\n";
        if (cmd === "cmux capabilities --json") return '{"capabilities":["surface.focus"]}\n';
        if (cmd === "cmux --help") return "cmux help\n";
        return "";
      },
    });
    const { checks } = runDoctorChecks(deps);
    const mouseCheck = checks.find((c) => c.name === "tmux_mouse");
    expect(mouseCheck?.status).toBe("warn");
    expect(mouseCheck?.message).toContain("disabled");
    expect(mouseCheck?.fix).toContain("tmux set -g mouse on");
    expect(mouseCheck?.fix).toContain("~/.tmux.conf");
    expect(mouseCheck?.fix).toContain("tmux source-file ~/.tmux.conf");
  });

  it("tmux missing -> fail with guidance", () => {
    const deps = makeDeps({
      exec: (cmd: string) => {
        if (cmd === "tmux -V") throw new Error("not found");
        return "";
      },
    });
    const { checks } = runDoctorChecks(deps);
    const tmuxCheck = checks.find((c) => c.name === "tmux");
    expect(tmuxCheck?.status).toBe("fail");
    expect(tmuxCheck?.fix).toContain("brew");
  });

  it("tmux mouse check is omitted on non-macOS hosts", () => {
    const deps = makeDeps({
      platform: "linux",
      exec: (cmd: string) => {
        if (cmd === "tmux -V") return "tmux 3.4\n";
        if (cmd === "cmux capabilities --json") return '{"capabilities":["surface.focus"]}\n';
        if (cmd === "cmux --help") return "cmux help\n";
        return "";
      },
    });
    const { checks } = runDoctorChecks(deps);
    expect(checks.find((c) => c.name === "tmux_mouse")).toBeUndefined();
  });

  it("cmux_shell pass when shell capabilities work", () => {
    const deps = makeDeps();
    const { checks } = runDoctorChecks(deps);
    const cmuxShell = checks.find((c) => c.name === "cmux_shell");
    expect(cmuxShell?.status).toBe("pass");
  });

  it("cmux_shell warn when shell cmux installed but control unavailable", () => {
    const deps = makeDeps({
      readFile: (filePath: string) => filePath === CMUX_SETTINGS_PATH ? "{\n  \"automation\": {\n    \"socketControlMode\": \"cmuxOnly\"\n  }\n}\n" : null,
      exec: (cmd: string) => {
        if (cmd === "tmux -V") return "tmux 3.4\n";
        if (cmd === "cmux capabilities --json") {
          throw new Error("Failed to connect to socket at /tmp/cmux.sock");
        }
        if (cmd === "cmux --help") return "cmux help\n";
        return "";
      },
    });
    const { checks } = runDoctorChecks(deps);
    const cmuxShell = checks.find((c) => c.name === "cmux_shell");
    expect(cmuxShell?.status).toBe("warn");
    expect(cmuxShell?.message).toContain("control unavailable");
    expect(cmuxShell?.fix).toContain("cmuxOnly");
    expect(cmuxShell?.fix).toContain("socketControlMode");
  });

  it("cmux_shell warn when cmux missing", () => {
    const deps = makeDeps({
      exec: (cmd: string) => {
        if (cmd === "tmux -V") return "tmux 3.4\n";
        throw new Error("command not found: cmux");
      },
    });
    const { checks } = runDoctorChecks(deps);
    const cmuxShell = checks.find((c) => c.name === "cmux_shell");
    expect(cmuxShell?.status).toBe("warn");
    expect(cmuxShell?.message).toContain("not found");
  });

  it("shell cmux pass + daemon cmux unavailable -> cmux_daemon warn with mismatch guidance", async () => {
    const deps = makeDeps({
      fetch: async (url: string) => {
        if (url.includes("/healthz")) return { ok: true } as Response;
        if (url.includes("/adapters/cmux/status")) return { ok: true, json: async () => ({ available: false }) } as Response;
        return { ok: true } as Response;
      },
      checkPort: async () => false, // port in use = daemon running
    });
    const { checks, asyncChecks } = runDoctorChecks(deps);
    const resolved = await Promise.all(asyncChecks ?? []);
    const allChecks = [...checks, ...resolved];

    const cmuxShell = allChecks.find((c) => c.name === "cmux_shell");
    expect(cmuxShell?.status).toBe("pass");

    const cmuxDaemon = allChecks.find((c) => c.name === "cmux_daemon");
    expect(cmuxDaemon).toBeDefined();
    expect(cmuxDaemon?.status).toBe("warn");
    expect(cmuxDaemon?.message).toContain("daemon cannot control");
    expect(cmuxDaemon?.fix).toContain("rig daemon start");
  });

  it("shell cmux pass + restrictive macOS socket control + daemon cmux unavailable -> cmux_daemon points at socket control mode", async () => {
    const deps = makeDeps({
      readFile: (filePath: string) => filePath === CMUX_SETTINGS_PATH ? "{\n  \"automation\": {\n    \"socketControlMode\": \"cmuxOnly\"\n  }\n}\n" : null,
      fetch: async (url: string) => {
        if (url.includes("/healthz")) return { ok: true } as Response;
        if (url.includes("/adapters/cmux/status")) return { ok: true, json: async () => ({ available: false }) } as Response;
        return { ok: true } as Response;
      },
      checkPort: async () => false,
    });

    const { checks, asyncChecks } = runDoctorChecks(deps);
    const resolved = await Promise.all(asyncChecks ?? []);
    const allChecks = [...checks, ...resolved];

    const cmuxDaemon = allChecks.find((c) => c.name === "cmux_daemon");
    expect(cmuxDaemon).toBeDefined();
    expect(cmuxDaemon?.status).toBe("warn");
    expect(cmuxDaemon?.reason).toContain("socketControlMode");
    expect(cmuxDaemon?.reason).toContain("cmuxOnly");
    expect(cmuxDaemon?.fix).toContain("rig setup");
    expect(cmuxDaemon?.fix).toContain("automation");
  });

  it("shell cmux pass + implicit default cmuxOnly + daemon cmux unavailable -> cmux_daemon points at effective default, not a fake file value", async () => {
    const deps = makeDeps({
      readFile: (filePath: string) => filePath === CMUX_SETTINGS_PATH ? null : null,
      fetch: async (url: string) => {
        if (url.includes("/healthz")) return { ok: true } as Response;
        if (url.includes("/adapters/cmux/status")) return { ok: true, json: async () => ({ available: false }) } as Response;
        return { ok: true } as Response;
      },
      checkPort: async () => false,
    });

    const { checks, asyncChecks } = runDoctorChecks(deps);
    const resolved = await Promise.all(asyncChecks ?? []);
    const allChecks = [...checks, ...resolved];

    const cmuxDaemon = allChecks.find((c) => c.name === "cmux_daemon");
    expect(cmuxDaemon?.status).toBe("warn");
    expect(cmuxDaemon?.reason).toContain("default");
    expect(cmuxDaemon?.reason).toContain("cmuxOnly");
    expect(cmuxDaemon?.reason).not.toContain("is 'cmuxOnly' in");
  });

  it("shell cmux pass + unreadable cmux settings -> cmux_daemon warns about parse failure", async () => {
    const deps = makeDeps({
      readFile: (filePath: string) => filePath === CMUX_SETTINGS_PATH ? "{\n  invalid\n" : null,
      fetch: async (url: string) => {
        if (url.includes("/healthz")) return { ok: true } as Response;
        if (url.includes("/adapters/cmux/status")) return { ok: true, json: async () => ({ available: false }) } as Response;
        return { ok: true } as Response;
      },
      checkPort: async () => false,
    });

    const { checks, asyncChecks } = runDoctorChecks(deps);
    const resolved = await Promise.all(asyncChecks ?? []);
    const allChecks = [...checks, ...resolved];

    const cmuxDaemon = allChecks.find((c) => c.name === "cmux_daemon");
    expect(cmuxDaemon?.status).toBe("warn");
    expect(cmuxDaemon?.reason).toContain("unreadable");
    expect(cmuxDaemon?.fix).toContain("~/.config/cmux/settings.json");
  });

  it("shell cmux pass + compatible password mode + daemon cmux unavailable -> falls back to generic daemon warning", async () => {
    const deps = makeDeps({
      readFile: (filePath: string) => filePath === CMUX_SETTINGS_PATH ? "{\n  \"automation\": {\n    \"socketControlMode\": \"password\"\n  }\n}\n" : null,
      fetch: async (url: string) => {
        if (url.includes("/healthz")) return { ok: true } as Response;
        if (url.includes("/adapters/cmux/status")) return { ok: true, json: async () => ({ available: false }) } as Response;
        return { ok: true } as Response;
      },
      checkPort: async () => false,
    });

    const { checks, asyncChecks } = runDoctorChecks(deps);
    const resolved = await Promise.all(asyncChecks ?? []);
    const allChecks = [...checks, ...resolved];

    const cmuxDaemon = allChecks.find((c) => c.name === "cmux_daemon");
    expect(cmuxDaemon?.status).toBe("warn");
    expect(cmuxDaemon?.reason).toContain("inherited a terminal/session environment");
    expect(cmuxDaemon?.reason).not.toContain("socketControlMode");
  });

  it("daemon not running -> cmux_daemon skipped and does not make doctor unhealthy", async () => {
    const deps = makeDeps({
      checkPort: async () => true,
      fetch: async () => { throw new Error("ECONNREFUSED"); },
    });
    const { checks, asyncChecks } = runDoctorChecks(deps);
    const resolved = await Promise.all(asyncChecks ?? []);
    const allChecks = [...checks, ...resolved];

    const cmuxDaemon = allChecks.find((c) => c.name === "cmux_daemon");
    expect(cmuxDaemon).toBeDefined();
    expect(cmuxDaemon?.status).toBe("skipped");
    expect(cmuxDaemon?.message).toContain("not reachable");

    const healthy = allChecks.every((c) => c.status !== "fail");
    expect(healthy).toBe(true);
  });

  it("daemon cmux available -> cmux_daemon pass", async () => {
    const deps = makeDeps({
      fetch: async (url: string) => {
        if (url.includes("/healthz")) return { ok: true } as Response;
        if (url.includes("/adapters/cmux/status")) return { ok: true, json: async () => ({ available: true }) } as Response;
        return { ok: true } as Response;
      },
      checkPort: async () => false, // port in use = daemon running
    });
    const { checks, asyncChecks } = runDoctorChecks(deps);
    const resolved = await Promise.all(asyncChecks ?? []);
    const allChecks = [...checks, ...resolved];

    const cmuxDaemon = allChecks.find((c) => c.name === "cmux_daemon");
    expect(cmuxDaemon).toBeDefined();
    expect(cmuxDaemon?.status).toBe("pass");
  });

  it("shell cmux missing -> no cmux_daemon check (no misleading signal)", async () => {
    const deps = makeDeps({
      exec: (cmd: string) => {
        if (cmd === "tmux -V") return "tmux 3.4\n";
        throw new Error("command not found: cmux");
      },
      checkPort: async () => false, // daemon running
      fetch: async (url: string) => {
        if (url.includes("/healthz")) return { ok: true } as Response;
        if (url.includes("/adapters/cmux/status")) return { ok: true, json: async () => ({ available: false }) } as Response;
        return { ok: true } as Response;
      },
    });
    const { checks, asyncChecks } = runDoctorChecks(deps);
    const resolved = await Promise.all(asyncChecks ?? []);
    const allChecks = [...checks, ...resolved];

    const cmuxDaemon = allChecks.find((c) => c.name === "cmux_daemon");
    expect(cmuxDaemon).toBeUndefined();
  });

  it("Node version check passes on current Node", () => {
    const deps = makeDeps();
    const { checks } = runDoctorChecks(deps);
    const nodeCheck = checks.find((c) => c.name === "node_version");
    expect(nodeCheck?.status).toBe("pass");
  });

  it("writable_home missing -> fail with guidance", () => {
    const deps = makeDeps({
      checkWritable: () => {
        throw new Error("permission denied");
      },
    });
    const { checks } = runDoctorChecks(deps);
    const writableCheck = checks.find((c) => c.name === "writable_home");
    expect(writableCheck?.status).toBe("fail");
    expect(writableCheck?.message).toContain("Cannot write");
    expect(writableCheck?.fix).toContain("permissions");
  });

  it("port available -> pass", async () => {
    const deps = makeDeps({ checkPort: async () => true });
    const { portCheck } = runDoctorChecks(deps);
    const result = await portCheck;
    expect(result.status).toBe("pass");
  });

  it("port blocked by non-daemon process -> fail with guidance", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => { throw new Error("refused"); }) as unknown as typeof fetch;
    try {
      const deps = makeDeps({ checkPort: async () => false });
      const { portCheck } = runDoctorChecks(deps);
      const result = await portCheck;
      expect(result.status).toBe("fail");
      expect(result.reason).toContain("port");
      expect(result.fix).toContain("7433");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("port in use by OpenRig daemon -> pass", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: true })) as unknown as typeof fetch;
    try {
      const deps = makeDeps({ checkPort: async () => false });
      const { portCheck } = runDoctorChecks(deps);
      const result = await portCheck;
      expect(result.status).toBe("pass");
      expect(result.message).toContain("OpenRig daemon");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("rig doctor", () => {
  function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
    return new Promise(async (resolve) => {
      const logs: string[] = [];
      const origLog = console.log;
      const origErr = console.error;
      const origExitCode = process.exitCode;
      process.exitCode = undefined;
      console.log = (...args: unknown[]) => logs.push(args.join(" "));
      console.error = (...args: unknown[]) => logs.push(args.join(" "));
      try { await fn(); } finally {
        console.log = origLog;
        console.error = origErr;
      }
      const exitCode = process.exitCode;
      process.exitCode = origExitCode;
      resolve({ logs, exitCode });
    });
  }

  it("--json produces structured output", async () => {
    const deps = makeDeps();
    const program = new Command();
    program.addCommand(doctorCommand(deps));

    const { logs } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "doctor", "--json"]),
    );

    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.healthy).toBe(true);
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks.length).toBeGreaterThan(0);
  });

  it("--json stays healthy when cmux is only a warning", async () => {
    const deps = makeDeps({
      exec: (cmd: string) => {
        if (cmd === "tmux -V") return "tmux 3.4\n";
        if (cmd === "cmux capabilities --json") {
          throw new Error("Failed to connect to socket at /tmp/cmux.sock");
        }
        if (cmd === "cmux --help") return "cmux help\n";
        return "";
      },
    });
    const program = new Command();
    program.addCommand(doctorCommand(deps));

    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "doctor", "--json"]),
    );

    const parsed = JSON.parse(logs.join("\n"));
    const cmuxShellCheck = parsed.checks.find((check: { name: string }) => check.name === "cmux_shell");
    expect(parsed.healthy).toBe(true);
    expect(cmuxShellCheck.status).toBe("warn");
    expect(exitCode).toBeUndefined();
  });

  it("--json exits non-zero when writable state paths fail", async () => {
    const deps = makeDeps({
      checkWritable: () => {
        throw new Error("permission denied");
      },
    });
    const program = new Command();
    program.addCommand(doctorCommand(deps));

    const { logs, exitCode } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "doctor", "--json"]),
    );

    const parsed = JSON.parse(logs.join("\n"));
    const writableCheck = parsed.checks.find((check: { name: string }) => check.name === "writable_home");
    expect(parsed.healthy).toBe(false);
    expect(writableCheck.status).toBe("fail");
    expect(exitCode).toBe(1);
  });

  it("--json surfaces cmux_daemon pass when daemon cmux is available", async () => {
    const deps = makeDeps({
      fetch: async (url: string) => {
        if (url.includes("/healthz")) return { ok: true } as Response;
        if (url.includes("/adapters/cmux/status")) return { ok: true, json: async () => ({ available: true }) } as Response;
        return { ok: true } as Response;
      },
    });
    const program = new Command();
    program.addCommand(doctorCommand(deps));

    const { logs } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "doctor", "--json"]),
    );

    const parsed = JSON.parse(logs.join("\n"));
    const cmuxDaemon = parsed.checks.find((check: { name: string }) => check.name === "cmux_daemon");
    expect(cmuxDaemon).toBeDefined();
    expect(cmuxDaemon.status).toBe("pass");
  });

  it("--json surfaces cmux_daemon warn when shell cmux works but daemon cannot control", async () => {
    const deps = makeDeps({
      fetch: async (url: string) => {
        if (url.includes("/healthz")) return { ok: true } as Response;
        if (url.includes("/adapters/cmux/status")) return { ok: true, json: async () => ({ available: false }) } as Response;
        return { ok: true } as Response;
      },
    });
    const program = new Command();
    program.addCommand(doctorCommand(deps));

    const { logs } = await captureLogs(() =>
      program.parseAsync(["node", "rig", "doctor", "--json"]),
    );

    const parsed = JSON.parse(logs.join("\n"));
    const cmuxDaemon = parsed.checks.find((check: { name: string }) => check.name === "cmux_daemon");
    expect(cmuxDaemon).toBeDefined();
    expect(cmuxDaemon.status).toBe("warn");
    expect(parsed.healthy).toBe(true); // warn does not make doctor unhealthy
  });

  it("wired via createProgram", async () => {
    const program = createProgram();
    const doctorCmd = program.commands.find((c) => c.name() === "doctor");
    expect(doctorCmd).toBeDefined();
  });

  // ===================================================================
  // SLICE-05 item-4 (D4b) — doctor hardcoded-target RED.
  // runDoctorChecks probes 127.0.0.1:DEFAULT_PORT(7433) for port/health/cmux and
  // consults configStore.resolve() ONLY for writable paths — so a healthy daemon
  // on a NON-default configured port is invisible to these checks (deterministic
  // false-negative). RED pins that the checks TARGET the configured daemon port;
  // default-port config is preserved.
  // ===================================================================
  it("Slice-05 D4b RED: doctor port/health/cmux must target the CONFIGURED host+port, not hardcoded 127.0.0.1:7433", async () => {
    const checkPortArgs: unknown[] = [];
    const fetchUrls: string[] = [];
    const deps = makeDeps({
      configStore: { resolve: () => ({ ...defaultConfig, daemon: { port: 8999, host: "10.0.0.5" } }) },
      // Widened test double (test-only): capture ALL args so we can prove the configured
      // HOST is passed, not only the port. Cast to the current (port)-only dep type.
      checkPort: ((...args: unknown[]) => {
        checkPortArgs.push(...args);
        return Promise.resolve(false); // in use = a daemon is there
      }) as unknown as (port: number) => Promise<boolean>,
      fetch: async (url: string) => {
        fetchUrls.push(url);
        return { ok: true, json: async () => ({ available: true }) } as unknown as { ok: boolean };
      },
    });
    const { portCheck, asyncChecks } = runDoctorChecks(deps);
    await portCheck;
    await Promise.all(asyncChecks ?? []);
    // checkPort must receive BOTH the configured port AND the configured host.
    expect(checkPortArgs).toContain(8999); // <-- RED: currently 7433
    expect(checkPortArgs).toContain("10.0.0.5"); // <-- RED: host is never passed to checkPort today
    // fetch must hit the configured host:port for BOTH healthz and cmux status.
    expect(fetchUrls.some((u) => u.includes("http://10.0.0.5:8999/healthz"))).toBe(true); // <-- RED
    expect(fetchUrls.some((u) => u.includes("http://10.0.0.5:8999/api/adapters/cmux/status"))).toBe(true); // <-- RED
    // and NO hardcoded default target anywhere.
    expect(fetchUrls.some((u) => u.includes("127.0.0.1:7433"))).toBe(false); // <-- RED
  });

  it("Slice-05 D4b preserve (GREEN): default-port config still targets 7433", async () => {
    const portArgs: number[] = [];
    const deps = makeDeps({ checkPort: async (port: number) => { portArgs.push(port); return true; } });
    const { portCheck } = runDoctorChecks(deps);
    await portCheck;
    expect(portArgs).toContain(7433);
  });
});
