import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { agentCommand, type AgentDeps } from "../src/commands/agent.js";
import { DaemonClient } from "../src/client.js";
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

function runningState(port: number): DaemonState {
  return { pid: 123, port, db: "test.sqlite", startedAt: "2026-03-29T00:00:00Z" };
}

function runningLifecycleDeps(port: number): LifecycleDeps {
  return mockLifecycleDeps({
    exists: vi.fn((p: string) => p === STATE_FILE),
    readFile: vi.fn((p: string) => {
      if (p === STATE_FILE) return JSON.stringify(runningState(port));
      return null;
    }),
    fetch: vi.fn(async () => ({ ok: true })),
  });
}

function createMockDaemon() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // POST /api/agents/validate
    if (req.method === "POST" && url.pathname === "/api/agents/validate") {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString(); });
      req.on("end", () => {
        if (body.includes("INVALID")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ valid: false, errors: ["name is required", "missing runtime"] }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ valid: true, errors: [] }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return {
    server,
    close: () => new Promise<void>((r) => server.close(() => r())),
    listen: () => new Promise<number>((r) => {
      server.listen(0, () => {
        const addr = server.address();
        r(typeof addr === "object" && addr ? addr.port : 0);
      });
    }),
  };
}

describe("rig agent", () => {
  let srv: ReturnType<typeof createMockDaemon>;
  let port: number;

  beforeAll(async () => {
    srv = createMockDaemon();
    port = await srv.listen();
  });
  afterAll(async () => { await srv.close(); });

  function agentDeps(fileContent: string): AgentDeps {
    return {
      lifecycleDeps: runningLifecycleDeps(port),
      clientFactory: (baseUrl) => new DaemonClient(baseUrl),
      readFile: vi.fn(() => fileContent),
    };
  }

  // T1: rig agent validate valid spec -> exit 0, output contains "valid"
  it("agent validate valid spec: prints valid + name + version", async () => {
    const deps = agentDeps("name: my-agent\nversion: 1.2.0\nruntime: claude-code\n");
    const program = new Command();
    program.addCommand(agentCommand(deps));
    const { logs, exitCode } = await captureLogs(() => program.parseAsync(["node", "rig", "agent", "validate", "agent.yaml"]));
    const output = logs.join("\n");
    expect(output).toContain("Agent spec valid");
    expect(output).toContain("my-agent");
    expect(output).toContain("v1.2.0");
    expect(exitCode).toBeUndefined();
  });

  // T2: rig agent validate invalid spec -> exit 1, output contains error
  it("agent validate invalid spec: prints errors, exitCode 1", async () => {
    const deps = agentDeps("INVALID");
    const program = new Command();
    program.addCommand(agentCommand(deps));
    const { logs, exitCode } = await captureLogs(() => program.parseAsync(["node", "rig", "agent", "validate", "agent.yaml"]));
    const output = logs.join("\n");
    expect(output).toContain("name is required");
    expect(output).toContain("missing runtime");
    expect(exitCode).toBe(1);
  });
});
