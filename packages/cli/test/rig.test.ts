import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { rigCommand, type RigDeps } from "../src/commands/rig.js";
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

// Track received headers for assertion
let capturedHeaders: Record<string, string | undefined> = {};

function createMockDaemon() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // POST /api/rigs/import/validate
    if (req.method === "POST" && url.pathname === "/api/rigs/import/validate") {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString(); });
      req.on("end", () => {
        if (body.includes("INVALID")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ valid: false, errors: ["missing schema_version", "name is required"] }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ valid: true, errors: [] }));
        }
      });
      return;
    }

    // POST /api/rigs/import/preflight
    if (req.method === "POST" && url.pathname === "/api/rigs/import/preflight") {
      capturedHeaders = {
        "x-rig-root": req.headers["x-rig-root"] as string | undefined,
      };
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString(); });
      req.on("end", () => {
        if (body.includes("AMBIGUOUS")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ready: false, warnings: [], errors: ["ambiguous node collision: orchestrator defined in multiple pods"] }));
        } else if (body.includes("COLLISION")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ready: false, warnings: ["node name collision: worker shadows pod-a/worker"], errors: [] }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ready: true, warnings: ["cmux unavailable"], errors: [] }));
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

describe("rigged rig", () => {
  let srv: ReturnType<typeof createMockDaemon>;
  let port: number;

  beforeAll(async () => {
    srv = createMockDaemon();
    port = await srv.listen();
  });
  afterAll(async () => { await srv.close(); });

  function rigDeps(fileContent: string): RigDeps {
    return {
      lifecycleDeps: runningLifecycleDeps(port),
      clientFactory: (baseUrl) => new DaemonClient(baseUrl),
      readFile: vi.fn(() => fileContent),
    };
  }

  // T3: rigged rig validate invalid rig -> exit 1, output contains errors
  it("rig validate invalid: prints errors, exitCode 1", async () => {
    const deps = rigDeps("INVALID");
    const program = new Command();
    program.addCommand(rigCommand(deps));
    const { logs, exitCode } = await captureLogs(() => program.parseAsync(["node", "rigged", "rig", "validate", "rig.yaml"]));
    const output = logs.join("\n");
    expect(output).toContain("missing schema_version");
    expect(output).toContain("name is required");
    expect(exitCode).toBe(1);
  });

  // T4: rigged rig preflight -> exit 0, output contains "ready" + warnings
  it("rig preflight ready: prints ready + warnings", async () => {
    const deps = rigDeps("schema_version: 1\nname: test-rig\nnodes: []\n");
    const program = new Command();
    program.addCommand(rigCommand(deps));
    const { logs, exitCode } = await captureLogs(() => program.parseAsync(["node", "rigged", "rig", "preflight", "/tmp/rig.yaml"]));
    const output = logs.join("\n");
    expect(output).toContain("Preflight ready");
    expect(output).toContain("cmux unavailable");
    expect(exitCode).toBeUndefined();
  });

  // T7: rigged rig preflight with collision warnings -> output shows warnings
  it("rig preflight with collision warnings: shows warnings", async () => {
    const deps = rigDeps("schema_version: 1\nname: test-rig\nCOLLISION\nnodes: []\n");
    const program = new Command();
    program.addCommand(rigCommand(deps));
    const { logs, exitCode } = await captureLogs(() => program.parseAsync(["node", "rigged", "rig", "preflight", "/tmp/rig.yaml"]));
    const output = logs.join("\n");
    expect(output).toContain("node name collision");
    expect(output).toContain("not ready");
    expect(exitCode).toBe(1);
  });

  // T8: rigged rig preflight with ambiguous collision -> exit 1, output shows error
  it("rig preflight with ambiguous collision: exit 1, shows error", async () => {
    const deps = rigDeps("schema_version: 1\nname: test-rig\nAMBIGUOUS\nnodes: []\n");
    const program = new Command();
    program.addCommand(rigCommand(deps));
    const { logs, exitCode } = await captureLogs(() => program.parseAsync(["node", "rigged", "rig", "preflight", "/tmp/rig.yaml"]));
    const output = logs.join("\n");
    expect(output).toContain("ambiguous node collision");
    expect(output).toContain("not ready");
    expect(exitCode).toBe(1);
  });
});
