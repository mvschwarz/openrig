import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { upCommand } from "../src/commands/up.js";
import { DaemonClient } from "../src/client.js";
import { LOG_FILE, STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

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

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try { await fn(); } finally { console.log = origLog; console.error = origErr; }
    const exitCode = process.exitCode;
    process.exitCode = origExitCode;
    resolve({ logs, exitCode });
  });
}

function runningDeps(port: number): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-03-26T00:00:00Z" } as DaemonState);
        return null;
      }),
      fetch: vi.fn(async () => ({ ok: true })),
    }),
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
}

describe("Up CLI", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;

      if (req.url === "/api/up" && req.method === "POST") {
        const parsed = JSON.parse(body);
        if (parsed.plan) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "planned", runId: "run-1", stages: [{ stage: "resolve_spec", status: "ok" }], errors: [], warnings: [] }));
        } else {
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "completed", runId: "run-2", rigId: "rig-1", stages: [{ stage: "resolve_spec", status: "ok" }, { stage: "import_rig", status: "ok" }], errors: [], warnings: [], attachCommand: "tmux attach -t dev-impl@test-rig" }));
        }
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(upCommand(runningDeps(port)));
    return prog;
  }

  it("help makes --target scope explicit", () => {
    const help = makeCmd().commands.find((c) => c.name() === "up")!.helpInformation();
    expect(help).toContain("Target root directory for package installation");
    expect(help).toContain("does not change agent cwd");
    expect(help).toContain("--cwd <path>");
  });

  // T7: up from .yaml -> stages + rig ID
  it("up prints stages and rig ID", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "/tmp/rig.yaml"]);
    });
    expect(logs.some((l) => l.includes("resolve_spec"))).toBe(true);
    expect(logs.some((l) => l.includes("rig-1"))).toBe(true);
    expect(logs.some((l) => l.includes("completed"))).toBe(true);
  });

  // T8: up --plan
  it("up --plan prints planned status", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "/tmp/rig.yaml", "--plan"]);
    });
    expect(logs.some((l) => l.includes("planned"))).toBe(true);
  });

  // T9: --yes sends autoApprove
  it("up --yes sends autoApprove=true", async () => {
    let lastBody: Record<string, unknown> = {};
    const origListeners = server.listeners("request");
    server.removeAllListeners("request");
    server.on("request", async (req: http.IncomingMessage, res: http.ServerResponse) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (req.url === "/api/up") {
        lastBody = JSON.parse(body);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "completed", runId: "r", rigId: "g", stages: [], errors: [] }));
      }
    });

    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "/tmp/rig.yaml", "--yes"]);
    });

    expect(lastBody.autoApprove).toBe(true);

    server.removeAllListeners("request");
    for (const l of origListeners) server.on("request", l as (...args: unknown[]) => void);
  });

  // T10: --json
  it("up --json outputs parseable JSON", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "/tmp/rig.yaml", "--json"]);
    });
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.status).toBe("completed");
  });

  // T12: Failure -> exit 2
  it("failure response returns exit 2", async () => {
    const failServer = http.createServer((_, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "failed", error: "boom", stages: [], errors: ["boom"] }));
    });
    await new Promise<void>((resolve) => { failServer.listen(0, resolve); });
    const failPort = (failServer.address() as { port: number }).port;

    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(upCommand(runningDeps(failPort)));

    const { exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "up", "/tmp/rig.yaml"]);
    });

    expect(exitCode).toBe(2);
    failServer.close();
  });

  it("agent_ref resolution failures include local-ref guidance", async () => {
    const failServer = http.createServer((_, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "failed",
        error: "dev.impl: agent_ref resolution failed: No agent.yaml found at /tmp/agents/impl/agent.yaml",
        stages: [],
        errors: [],
      }));
    });
    await new Promise<void>((resolve) => { failServer.listen(0, resolve); });
    const failPort = (failServer.address() as { port: number }).port;

    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(upCommand(runningDeps(failPort)));

    const { logs, exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "up", "/tmp/rig.yaml"]);
    });

    const output = logs.join("\n");
    expect(output).toContain("agent_ref resolution failed");
    expect(output).toContain("local: agent_ref paths resolve relative to the rig spec directory");
    expect(exitCode).toBe(2);
    failServer.close();
  });

  // T13: Relative path resolved to absolute before sending
  it("resolves relative path to absolute in POST body", async () => {
    let lastBody: Record<string, unknown> = {};
    const origListeners = server.listeners("request");
    server.removeAllListeners("request");
    server.on("request", async (req: http.IncomingMessage, res: http.ServerResponse) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (req.url === "/api/up") {
        lastBody = JSON.parse(body);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "completed", runId: "r", rigId: "g", stages: [], errors: [] }));
      }
    });

    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "relative/spec.yaml"]);
    });

    // sourceRef must be an absolute path, not the raw relative input
    expect(lastBody.sourceRef).toMatch(/^\//);
    expect((lastBody.sourceRef as string).endsWith("relative/spec.yaml")).toBe(true);

    server.removeAllListeners("request");
    for (const l of origListeners) server.on("request", l as (...args: unknown[]) => void);
  });

  it("up from .rigbundle defaults targetRoot to current working directory", async () => {
    let lastBody: Record<string, unknown> = {};
    const origListeners = server.listeners("request");
    server.removeAllListeners("request");
    server.on("request", async (req: http.IncomingMessage, res: http.ServerResponse) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (req.url === "/api/up") {
        lastBody = JSON.parse(body);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "completed", runId: "r", rigId: "g", stages: [], errors: [] }));
      }
    });

    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "/tmp/demo.rigbundle"]);
    });

    expect(lastBody.sourceRef).toBe("/tmp/demo.rigbundle");
    expect(lastBody.targetRoot).toBe(process.cwd());

    server.removeAllListeners("request");
    for (const l of origListeners) server.on("request", l as (...args: unknown[]) => void);
  });

  it("up from .rigbundle preserves explicit --target", async () => {
    let lastBody: Record<string, unknown> = {};
    const origListeners = server.listeners("request");
    server.removeAllListeners("request");
    server.on("request", async (req: http.IncomingMessage, res: http.ServerResponse) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (req.url === "/api/up") {
        lastBody = JSON.parse(body);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "completed", runId: "r", rigId: "g", stages: [], errors: [] }));
      }
    });

    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "/tmp/demo.rigbundle", "--target", "/tmp/custom-root"]);
    });

    expect(lastBody.targetRoot).toBe("/tmp/custom-root");

    server.removeAllListeners("request");
    for (const l of origListeners) server.on("request", l as (...args: unknown[]) => void);
  });

  it("up --cwd sends absolute cwdOverride", async () => {
    let lastBody: Record<string, unknown> = {};
    const origListeners = server.listeners("request");
    server.removeAllListeners("request");
    server.on("request", async (req: http.IncomingMessage, res: http.ServerResponse) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (req.url === "/api/up") {
        lastBody = JSON.parse(body);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "completed", runId: "r", rigId: "g", stages: [], errors: [] }));
      }
    });

    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "/tmp/rig.yaml", "--cwd", "relative/project"]);
    });

    expect(lastBody.cwdOverride).toMatch(/^\//);
    expect((lastBody.cwdOverride as string).endsWith("relative/project")).toBe(true);

    server.removeAllListeners("request");
    for (const l of origListeners) server.on("request", l as (...args: unknown[]) => void);
  });

  // NS-T14: fresh boot handoff includes dashboard URL + attach command
  it("fresh boot success shows dashboard URL and attach command", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "/tmp/test.yaml"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("Dashboard: rig ui open");
    expect(output).toContain("Attach:");
    expect(output).toContain("tmux attach -t dev-impl@test-rig");
  });

  // PNS-T06: fresh boot warnings (e.g. transcript attach failures) surface to stderr
  it("fresh boot success prints warnings when present", async () => {
    const origListeners = server.listeners("request");
    server.removeAllListeners("request");
    server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk; });
      req.on("end", () => {
        if (req.url === "/api/up" && req.method === "POST") {
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            status: "completed", runId: "run-3", rigId: "rig-2",
            stages: [{ stage: "import_rig", status: "ok" }],
            errors: [],
            warnings: ["Transcript capture failed for dev-impl@test-rig: pipe-pane failed"],
          }));
        } else {
          res.writeHead(404).end();
        }
      });
    });

    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "/tmp/test.yaml"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("warning: Transcript capture failed");

    server.removeAllListeners("request");
    for (const l of origListeners) server.on("request", l as (...args: unknown[]) => void);
  });

  // PNS-T03: rig up aborts on preflight failure (daemon not running, port in use)
  it("up aborts with preflight error when daemon not running and port in use", async () => {
    // Start a TCP server on a port to trigger port-in-use
    const net = await import("node:net");
    const blockingServer = net.createServer();
    await new Promise<void>((resolve) => blockingServer.listen(0, resolve));
    const blockedPort = (blockingServer.address() as { port: number }).port;

    // Create deps where daemon is NOT running (triggers auto-start → preflight)
    const stoppedDeps: StatusDeps = {
      lifecycleDeps: {
        ...mockLifecycleDeps(),
        exists: vi.fn(() => false), // No daemon.json → stopped
        readFile: vi.fn(() => null),
        fetch: vi.fn(async () => { throw new Error("refused"); }),
      },
      clientFactory: (baseUrl) => new DaemonClient(baseUrl),
    };

    // Set OPENRIG_PORT to the blocked port so preflight detects collision
    const savedPort = process.env["OPENRIG_PORT"];
    process.env["OPENRIG_PORT"] = String(blockedPort);

    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(upCommand(stoppedDeps));

    const { logs, exitCode } = await captureLogs(async () => {
      try {
        await prog.parseAsync(["node", "rig", "up", "/tmp/test.yaml"]);
      } catch { /* commander may throw on exitOverride */ }
    });
    blockingServer.close();
    if (savedPort !== undefined) process.env["OPENRIG_PORT"] = savedPort;
    else delete process.env["OPENRIG_PORT"];

    const output = logs.join("\n");
    expect(output).toContain("port");
    expect(exitCode).toBe(1);
  });

  it("auto-start uses resolved daemon port instead of default 7433", async () => {
    const savedPort = process.env["OPENRIG_PORT"];
    process.env["OPENRIG_PORT"] = "7461";

    let daemonState: DaemonState | null = null;
    let spawnedPort: string | undefined;
    let clientBaseUrl: string | undefined;

    const deps: StatusDeps = {
      lifecycleDeps: {
        ...mockLifecycleDeps(),
        exists: vi.fn((p: string) => p === STATE_FILE ? daemonState !== null : false),
        readFile: vi.fn((p: string) => p === STATE_FILE && daemonState ? JSON.stringify(daemonState) : null),
        writeFile: vi.fn((p: string, content: string) => {
          if (p === STATE_FILE) daemonState = JSON.parse(content) as DaemonState;
        }),
        openForAppend: vi.fn(() => 3),
        mkdirp: vi.fn(),
        spawn: vi.fn((cmd, args, opts) => {
          spawnedPort = opts.env["OPENRIG_PORT"];
          return { pid: 321, unref: vi.fn() } as never;
        }),
        fetch: vi.fn(async (url: string) => ({
          ok: url === "http://127.0.0.1:7461/healthz" || url === "http://127.0.0.1:7433/healthz",
        })),
      },
      clientFactory: (baseUrl) => {
        clientBaseUrl = baseUrl;
        return {
          post: vi.fn(async () => ({
            status: 201,
            data: { status: "completed", rigId: "rig-1", stages: [], errors: [], warnings: [] },
          })),
        } as unknown as DaemonClient;
      },
    };

    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(upCommand(deps));

    const { exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "up", "/tmp/test.yaml"]);
    });

    if (savedPort !== undefined) process.env["OPENRIG_PORT"] = savedPort;
    else delete process.env["OPENRIG_PORT"];

    expect(exitCode).toBeUndefined();
    expect(spawnedPort).toBe("7461");
    expect(clientBaseUrl).toBe("http://127.0.0.1:7461");
  });

  it("up surfaces the real daemon auto-start failure instead of a generic hint", async () => {
    const savedPort = process.env["OPENRIG_PORT"];
    process.env["OPENRIG_PORT"] = "7463";
    const deps: StatusDeps = {
      lifecycleDeps: {
        ...mockLifecycleDeps(),
        exists: vi.fn(() => false),
        readFile: vi.fn((p: string) => {
          if (p === LOG_FILE) {
            return [
              "Error: The module '/tmp/better_sqlite3.node'",
              "was compiled against a different Node.js version using",
              "NODE_MODULE_VERSION 127. This version of Node.js requires",
              "NODE_MODULE_VERSION 141.",
              "code: 'ERR_DLOPEN_FAILED'",
            ].join("\n");
          }
          return null;
        }),
        fetch: vi.fn(async () => { throw new Error("refused"); }),
      },
      clientFactory: (baseUrl) => new DaemonClient(baseUrl),
    };

    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(upCommand(deps));

    const { logs, exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "up", "/tmp/test.yaml"]);
    });
    if (savedPort !== undefined) process.env["OPENRIG_PORT"] = savedPort;
    else delete process.env["OPENRIG_PORT"];

    const output = logs.join("\n");
    expect(output).toContain("better-sqlite3");
    expect(output).toContain("Node");
    expect(output).not.toContain("Failed to auto-start daemon. Start manually with: rig daemon start");
    expect(exitCode).toBe(2);
  }, 15000);

  it("up with library name matching existing rig shows ambiguity error", async () => {
    // Mock server that has both a library spec and an existing rig named "my-rig"
    const origListeners = server.listeners("request");
    server.removeAllListeners("request");
    server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = decodeURIComponent(req.url ?? "");
      if (url.startsWith("/api/specs/library")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([{ id: "lib1", name: "alpha", sourcePath: "/specs/alpha.yaml" }]));
      } else if (url === "/api/rigs/summary") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([{ id: "r1", name: "alpha", nodeCount: 1 }]));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({}));
      }
    });

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "up", "alpha"]);
    });

    server.removeAllListeners("request");
    for (const l of origListeners) server.on("request", l as (...args: unknown[]) => void);

    expect(logs.join("\n")).toContain("ambiguous");
    expect(logs.join("\n")).toContain("existing rig restore target");
    expect(logs.join("\n")).toContain("/specs/alpha.yaml");
    expect(exitCode).toBe(1);
  });
});
