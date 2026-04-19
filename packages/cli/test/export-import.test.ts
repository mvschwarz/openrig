import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { exportCommand, type ExportDeps } from "../src/commands/export.js";
import { importCommand, type ImportDeps } from "../src/commands/import.js";
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

function stoppedLifecycleDeps(): LifecycleDeps {
  return mockLifecycleDeps({
    exists: vi.fn(() => false),
    fetch: vi.fn(async () => { throw new Error("refused"); }),
  });
}

function unhealthyLifecycleDeps(): LifecycleDeps {
  return mockLifecycleDeps({
    exists: vi.fn((p: string) => p === STATE_FILE),
    readFile: vi.fn((p: string) => {
      if (p === STATE_FILE) return JSON.stringify(runningState(7433));
      return null;
    }),
    isProcessAlive: vi.fn(() => true),
    fetch: vi.fn(async () => { throw new Error("refused"); }),
  });
}

// Track captured headers for import assertions
let capturedImportHeaders: Record<string, string | string[] | undefined> = {};

// Mock daemon for export/import
function createMockDaemon() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");

    // GET /api/rigs/:rigId/spec -> YAML
    if (req.method === "GET" && url.pathname.match(/^\/api\/rigs\/[^/]+\/spec$/)) {
      const rigId = url.pathname.split("/")[3]!;
      if (rigId === "missing") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "rig not found" }));
        return;
      }
      if (rigId === "broken") {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("internal server error");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/yaml" });
      res.end("schema_version: 1\nname: test-rig\nnodes: []\n");
      return;
    }

    // POST /api/rigs/import/validate
    if (req.method === "POST" && url.pathname === "/api/rigs/import/validate") {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString(); });
      req.on("end", () => {
        if (body.includes("INVALID")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ valid: false, errors: ["bad yaml"] }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ valid: true, errors: [] }));
        }
      });
      return;
    }

    // POST /api/rigs/import/preflight
    if (req.method === "POST" && url.pathname === "/api/rigs/import/preflight") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ready: false, warnings: ["cmux unavailable"], errors: ["rig name exists"] }));
      return;
    }

    // POST /api/rigs/import
    if (req.method === "POST" && url.pathname === "/api/rigs/import") {
      capturedImportHeaders = {
        "x-rig-root": req.headers["x-rig-root"],
      };
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString(); });
      req.on("end", () => {
        if (body.includes("CONFLICT")) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, code: "preflight_failed", message: "conflict" }));
        } else {
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ rigId: "rig-new", specName: "imported-rig", specVersion: "0.1.0", nodes: [{ logicalId: "orchestrator", status: "launched" }, { logicalId: "worker", status: "launched" }], attachCommand: "tmux attach -t orch-lead@imported-rig" }));
        }
      });
      return;
    }

    // POST /api/rigs/import/materialize
    if (req.method === "POST" && url.pathname === "/api/rigs/import/materialize") {
      capturedImportHeaders = {
        "x-rig-root": req.headers["x-rig-root"],
        "x-target-rig-id": req.headers["x-target-rig-id"],
      };
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        rigId: req.headers["x-target-rig-id"] ?? "rig-new",
        specName: "imported-rig",
        specVersion: "0.2",
        nodes: [{ logicalId: "research.scout", status: "materialized" }],
      }));
      return;
    }

    // healthz
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
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

describe("rig export + import", () => {
  let srv: ReturnType<typeof createMockDaemon>;
  let port: number;

  beforeAll(async () => {
    srv = createMockDaemon();
    port = await srv.listen();
  });
  afterAll(async () => { await srv.close(); });

  function exportDeps(overrides?: Partial<ExportDeps>): ExportDeps {
    return {
      lifecycleDeps: runningLifecycleDeps(port),
      clientFactory: (baseUrl) => new DaemonClient(baseUrl),
      writeFile: vi.fn(),
      ...overrides,
    };
  }

  function importDeps(fileContent: string, overrides?: Partial<ImportDeps>): ImportDeps {
    return {
      lifecycleDeps: runningLifecycleDeps(port),
      clientFactory: (baseUrl) => new DaemonClient(baseUrl),
      readFile: vi.fn(() => fileContent),
      ...overrides,
    };
  }

  // Test 1: export writes YAML to -o path
  it("export: writes YAML to specified path", async () => {
    const writeFile = vi.fn();
    const deps = exportDeps({ writeFile });
    const program = new Command();
    program.addCommand(exportCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "export", "rig-1", "-o", "out.yaml"]));
    expect(writeFile).toHaveBeenCalledWith("out.yaml", "schema_version: 1\nname: test-rig\nnodes: []\n");
    expect(logs.join("\n")).toContain("out.yaml");
  });

  // Test 2: export default path rig.yaml
  it("export: default output path is rig.yaml", async () => {
    const writeFile = vi.fn();
    const deps = exportDeps({ writeFile });
    const program = new Command();
    program.addCommand(exportCommand(deps));
    await captureLogs(() => program.parseAsync(["node", "rig", "export", "rig-1"]));
    expect(writeFile).toHaveBeenCalledWith("rig.yaml", expect.any(String));
  });

  // Test 3: export rig not found (404)
  it("export: rig not found -> error", async () => {
    const deps = exportDeps();
    const program = new Command();
    program.addCommand(exportCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "export", "missing"]));
    expect(logs.join("\n")).toMatch(/not found/i);
  });

  // Test 4: import validate prints result
  it("import validate: prints valid result", async () => {
    const deps = importDeps("schema_version: 1\nname: test\n");
    const program = new Command();
    program.addCommand(importCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "import", "rig.yaml"]));
    expect(logs.join("\n")).toMatch(/valid/i);
  });

  // Test 5: import invalid YAML (400)
  it("import: invalid YAML -> errors", async () => {
    const deps = importDeps("INVALID");
    const program = new Command();
    program.addCommand(importCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "import", "rig.yaml"]));
    expect(logs.join("\n")).toMatch(/bad yaml|invalid/i);
  });

  // Test 6: import --instantiate prints per-node status
  it("import --instantiate: prints nodes", async () => {
    const deps = importDeps("schema_version: 1\nname: test\n");
    const program = new Command();
    program.addCommand(importCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "import", "rig.yaml", "--instantiate"]));
    const output = logs.join("\n");
    expect(output).toContain("imported-rig");
    expect(output).toContain("orchestrator");
    expect(output).toContain("worker");
    // Must include per-node status, not just names
    expect(output).toMatch(/orchestrator: launched/);
    expect(output).toMatch(/worker: launched/);
  });

  // Test 7: import --preflight prints warnings + errors
  it("import --preflight: prints warnings and errors", async () => {
    const deps = importDeps("schema_version: 1\nname: test\n");
    const program = new Command();
    program.addCommand(importCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "import", "rig.yaml", "--preflight"]));
    const output = logs.join("\n");
    expect(output).toContain("cmux unavailable");
    expect(output).toContain("rig name exists");
  });

  it("import --materialize-only prints materialized nodes", async () => {
    const deps = importDeps(`version: "0.2"\nname: test\npods: []\n`);
    const program = new Command();
    program.addCommand(importCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "import", "rig.yaml", "--materialize-only", "--rig-root", "/tmp"]));
    const output = logs.join("\n");
    expect(output).toContain("imported-rig");
    expect(output).toMatch(/research\.scout: materialized/);
  });

  it("import --materialize-only with --target-rig forwards target header", async () => {
    const deps = importDeps(`version: "0.2"\nname: test\npods: []\n`);
    const program = new Command();
    program.addCommand(importCommand(deps));
    await captureLogs(() => program.parseAsync(["node", "rig", "import", "rig.yaml", "--materialize-only", "--target-rig", "rig-123", "--rig-root", "/tmp"]));
    expect(capturedImportHeaders["x-target-rig-id"]).toBe("rig-123");
  });

  // Test 8: import --instantiate with preflight fail (409)
  it("import --instantiate: preflight conflict (409)", async () => {
    const deps = importDeps("CONFLICT");
    const program = new Command();
    program.addCommand(importCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "import", "rig.yaml", "--instantiate"]));
    expect(logs.join("\n")).toMatch(/conflict|failed/i);
  });

  // Test 9: export daemon stopped -> no HTTP
  it("export: daemon stopped -> no HTTP", async () => {
    const clientFactory = vi.fn();
    const deps: ExportDeps = {
      lifecycleDeps: stoppedLifecycleDeps(),
      clientFactory: clientFactory as unknown as ExportDeps["clientFactory"],
      writeFile: vi.fn(),
    };
    const program = new Command();
    program.addCommand(exportCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "export", "rig-1"]));
    expect(logs.join("\n")).toMatch(/not running/i);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  // Test 10: import uses stored port from daemon.json
  it("import: uses stored port from daemon.json", async () => {
    const usedUrls: string[] = [];
    const deps: ImportDeps = {
      lifecycleDeps: runningLifecycleDeps(port),
      clientFactory: (baseUrl) => { usedUrls.push(baseUrl); return new DaemonClient(baseUrl); },
      readFile: vi.fn(() => "schema_version: 1\nname: test\n"),
    };
    const program = new Command();
    program.addCommand(importCommand(deps));
    await captureLogs(() => program.parseAsync(["node", "rig", "import", "rig.yaml"]));
    expect(usedUrls[0]).toBe(`http://127.0.0.1:${port}`);
  });

  // Test 11: createProgram: both export AND import mounted
  it("createProgram mounts both export and import commands", async () => {
    const { createProgram } = await import("../src/index.js");
    const stoppedLC = stoppedLifecycleDeps();

    const exportD: ExportDeps = { lifecycleDeps: stoppedLC, clientFactory: vi.fn() as never, writeFile: vi.fn() };
    const importD: ImportDeps = { lifecycleDeps: stoppedLC, clientFactory: vi.fn() as never, readFile: vi.fn(() => "yaml") };

    // export mounted
    const p1 = createProgram({ exportDeps: exportD });
    const logs1 = await captureLogs(() => p1.parseAsync(["node", "rig", "export", "x"]));
    expect(logs1.join("\n")).toMatch(/not running/i);

    // import mounted
    const p2 = createProgram({ importDeps: importD });
    const logs2 = await captureLogs(() => p2.parseAsync(["node", "rig", "import", "x.yaml"]));
    // Will hit "cannot read file" or "not running" — either proves it's mounted
    expect(logs2.join("\n").length).toBeGreaterThan(0);
  });

  // Test 12: export unhealthy daemon -> error, no HTTP
  it("export: unhealthy daemon -> error, no HTTP", async () => {
    const clientFactory = vi.fn();
    const deps: ExportDeps = {
      lifecycleDeps: unhealthyLifecycleDeps(),
      clientFactory: clientFactory as unknown as ExportDeps["clientFactory"],
      writeFile: vi.fn(),
    };
    const program = new Command();
    program.addCommand(exportCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "export", "rig-1"]));
    expect(logs.join("\n")).toMatch(/unhealthy/i);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  // Test 13: import daemon stopped -> no HTTP
  it("import: daemon stopped -> no HTTP", async () => {
    const clientFactory = vi.fn();
    const deps: ImportDeps = {
      lifecycleDeps: stoppedLifecycleDeps(),
      clientFactory: clientFactory as unknown as ImportDeps["clientFactory"],
      readFile: vi.fn(() => "yaml"),
    };
    const program = new Command();
    program.addCommand(importCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "import", "rig.yaml"]));
    expect(logs.join("\n")).toMatch(/not running/i);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  // Test 14: import missing file -> clear error, no HTTP
  it("import: missing file -> error, no HTTP", async () => {
    const clientFactory = vi.fn();
    const deps: ImportDeps = {
      lifecycleDeps: runningLifecycleDeps(port),
      clientFactory: clientFactory as unknown as ImportDeps["clientFactory"],
      readFile: vi.fn(() => { throw new Error("ENOENT"); }),
    };
    const program = new Command();
    program.addCommand(importCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "import", "missing.yaml"]));
    expect(logs.join("\n")).toMatch(/cannot read/i);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  // Test 15: export 500 -> generic error
  it("export: 500 -> generic error", async () => {
    const deps = exportDeps();
    const program = new Command();
    program.addCommand(exportCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "export", "broken"]));
    expect(logs.join("\n")).toMatch(/failed|error/i);
  });

  // T5: import --instantiate pod-aware + --rig-root -> sends X-Rig-Root header
  it("import --instantiate pod-aware with --rig-root sends X-Rig-Root header", async () => {
    capturedImportHeaders = {};
    const deps = importDeps("schema_version: 1\nname: test\npods:\n  - name: pod-a\n");
    const program = new Command();
    program.addCommand(importCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "import", "rig.yaml", "--instantiate", "--rig-root", "/my/project"]));
    const output = logs.join("\n");
    expect(output).toContain("imported-rig");
    // Verify X-Rig-Root header was sent
    expect(capturedImportHeaders["x-rig-root"]).toMatch(/\/my\/project/);
  });

  // NS-T14: import --instantiate handoff includes attach command
  it("import --instantiate success shows attach command", async () => {
    const deps: ImportDeps = {
      lifecycleDeps: runningLifecycleDeps(port),
      clientFactory: (baseUrl) => new DaemonClient(baseUrl),
      readFile: () => 'version: "0.2"\nname: test\npods:\n  - id: dev\n    label: Dev\n    members:\n      - id: impl\n        agent_ref: "local:agents/impl"\n        profile: default\n        runtime: claude-code\n        cwd: .\n    edges: []\nedges: []',
    };
    const program = new Command();
    program.addCommand(importCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rig", "import", "rig.yaml", "--instantiate"]));
    const output = logs.join("\n");
    expect(output).toContain("Attach:");
    expect(output).toContain("tmux attach -t orch-lead@imported-rig");
  });

  it("import --instantiate uses a long-running daemon timeout budget", async () => {
    let timeoutMs: number | undefined;
    const postText = vi.fn(async (
      _path: string,
      _text: string,
      _contentType?: string,
      _extraHeaders?: Record<string, string>,
      options?: { timeoutMs?: number },
    ) => {
      timeoutMs = options?.timeoutMs;
      return {
        status: 201,
        data: {
          rigId: "rig-new",
          specName: "imported-rig",
          specVersion: "0.1.0",
          nodes: [{ logicalId: "orchestrator", status: "launched" }],
          attachCommand: "tmux attach -t orch-lead@imported-rig",
        },
      };
    });

    const deps: ImportDeps = {
      lifecycleDeps: runningLifecycleDeps(port),
      clientFactory: () => ({ postText } as unknown as DaemonClient),
      readFile: vi.fn(() => 'version: "0.2"\nname: test\npods:\n  - id: dev\n    label: Dev\n    members:\n      - id: impl\n        agent_ref: "local:agents/impl"\n        profile: default\n        runtime: claude-code\n        cwd: .\n    edges: []\nedges: []'),
    };

    const program = new Command();
    program.addCommand(importCommand(deps));

    await captureLogs(() => program.parseAsync(["node", "rig", "import", "rig.yaml", "--instantiate"]));

    expect(timeoutMs).toBe(120_000);
  });
});
