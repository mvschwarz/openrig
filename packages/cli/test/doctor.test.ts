import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { doctorCommand, runDoctorChecks, type DoctorDeps } from "../src/commands/doctor.js";

const defaultConfig = {
  daemon: { port: 7433, host: "127.0.0.1" },
  db: { path: "/tmp/openrig/openrig.sqlite" },
  transcripts: { enabled: true, path: "/tmp/openrig/transcripts" },
};

function makeDeps(overrides?: Partial<DoctorDeps>): DoctorDeps {
  return {
    exists: () => true,
    baseDir: "/install/cli/dist",
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
      baseDir: "/Users/mschwarz/code/rigged/packages/cli/src/commands",
      exists: (p) =>
        p === "/Users/mschwarz/code/rigged/packages/daemon/dist/index.js"
        || p === "/Users/mschwarz/code/rigged/packages/ui/dist/index.html",
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
        if (cmd === "tmux show-options -gqv mouse") return "on\n";
        return "";
      },
    });
    const { checks } = runDoctorChecks(deps);
    const tmuxCheck = checks.find((c) => c.name === "tmux");
    expect(tmuxCheck?.status).toBe("pass");
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

  it("cmux control available -> pass", () => {
    const deps = makeDeps({
      exec: (cmd: string) => {
        if (cmd === "tmux -V") return "tmux 3.4\n";
        if (cmd === "cmux capabilities --json") return '{"capabilities":["surface.focus"]}\n';
        if (cmd === "cmux --help") return "cmux help\n";
        return "";
      },
    });
    const { checks } = runDoctorChecks(deps);
    const cmuxCheck = checks.find((c) => c.name === "cmux");
    expect(cmuxCheck?.status).toBe("pass");
  });

  it("cmux installed but control unavailable -> warn with guidance", () => {
    const deps = makeDeps({
      exec: (cmd: string) => {
        if (cmd === "tmux -V") return "tmux 3.4\n";
        if (cmd === "cmux capabilities --json") {
          throw new Error("Failed to connect to socket at /tmp/cmux.sock");
        }
        if (cmd === "cmux --help") return "cmux help\n";
        if (cmd === "defaults read com.cmuxterm.app socketControlMode") return "localOnly\n";
        return "";
      },
    });
    const { checks } = runDoctorChecks(deps);
    const cmuxCheck = checks.find((c) => c.name === "cmux");
    expect(cmuxCheck?.status).toBe("warn");
    expect(cmuxCheck?.message).toContain("control unavailable");
    expect(cmuxCheck?.fix).toContain("tell the user");
    expect(cmuxCheck?.fix).toContain("socketControlMode");
    expect(cmuxCheck?.fix).toContain("localOnly");
  });

  it("cmux missing -> warn, not fail", () => {
    const deps = makeDeps({
      exec: (cmd: string) => {
        if (cmd === "tmux -V") return "tmux 3.4\n";
        throw new Error("command not found: cmux");
      },
    });
    const { checks } = runDoctorChecks(deps);
    const cmuxCheck = checks.find((c) => c.name === "cmux");
    expect(cmuxCheck?.status).toBe("warn");
    expect(cmuxCheck?.message).toContain("not found");
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
    const cmuxCheck = parsed.checks.find((check: { name: string }) => check.name === "cmux");
    expect(parsed.healthy).toBe(true);
    expect(cmuxCheck.status).toBe("warn");
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

  it("wired via createProgram", async () => {
    const { createProgram } = await import("../src/index.js");
    const program = createProgram();
    const doctorCmd = program.commands.find((c) => c.name() === "doctor");
    expect(doctorCmd).toBeDefined();
  });
});
