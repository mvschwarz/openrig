import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { snapshotCommand } from "../src/commands/snapshot.js";
import { restoreCommand } from "../src/commands/restore.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
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

function runningDeps(port: number): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(runningState(port));
        return null;
      }),
      fetch: vi.fn(async () => ({ ok: true })),
    }),
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
}

function stoppedDeps(): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps({ exists: vi.fn(() => false) }),
    clientFactory: vi.fn() as unknown as StatusDeps["clientFactory"],
  };
}

function unhealthyDeps(): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(runningState(7433));
        return null;
      }),
      isProcessAlive: vi.fn(() => true),
      fetch: vi.fn(async () => { throw new Error("refused"); }),
    }),
    clientFactory: vi.fn() as unknown as StatusDeps["clientFactory"],
  };
}

// Mock daemon server
function createMockDaemon() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");

    // POST /api/rigs/:rigId/snapshots
    if (req.method === "POST" && url.pathname.match(/^\/api\/rigs\/[^/]+\/snapshots$/)) {
      const rigId = url.pathname.split("/")[3]!;
      if (rigId === "missing") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "rig not found" }));
        return;
      }
      if (rigId === "broken") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
        return;
      }
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "snap-new-123" }));
      return;
    }

    // GET /api/rigs/:rigId/snapshots
    if (req.method === "GET" && url.pathname.match(/^\/api\/rigs\/[^/]+\/snapshots$/)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([
        { id: "snap-1", kind: "manual", status: "complete", createdAt: "2026-03-24 01:00:00" },
        { id: "snap-2", kind: "auto", status: "complete", createdAt: "2026-03-24 02:00:00" },
      ]));
      return;
    }

    // POST /api/rigs/:rigId/restore/:snapshotId
    if (req.method === "POST" && url.pathname.match(/^\/api\/rigs\/[^/]+\/restore\/[^/]+$/)) {
      const parts = url.pathname.split("/");
      const snapshotId = parts[5]!;
      if (snapshotId === "missing") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "snapshot not found" }));
        return;
      }
      if (snapshotId === "locked") {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "restore in progress" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        nodes: [
          { nodeId: "orchestrator", status: "resumed" },
          { nodeId: "worker", status: "checkpoint_written" },
        ],
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

describe("rigged snapshot + restore", () => {
  let srv: ReturnType<typeof createMockDaemon>;
  let port: number;

  beforeAll(async () => {
    srv = createMockDaemon();
    port = await srv.listen();
  });
  afterAll(async () => { await srv.close(); });

  // Test 1: snapshot create succeeds, prints ID
  it("snapshot create: prints snapshot ID", async () => {
    const program = new Command();
    program.addCommand(snapshotCommand(runningDeps(port)));
    const logs = await captureLogs(() => program.parseAsync(["node", "rigged", "snapshot", "rig-1"]));
    expect(logs.join("\n")).toContain("snap-new-123");
  });

  // Test 2: snapshot create 404
  it("snapshot create: rig not found (404) -> error", async () => {
    const program = new Command();
    program.addCommand(snapshotCommand(runningDeps(port)));
    const logs = await captureLogs(() => program.parseAsync(["node", "rigged", "snapshot", "missing"]));
    expect(logs.join("\n")).toMatch(/not found/i);
  });

  // Test 3: snapshot list formatted table
  it("snapshot list: formatted table output", async () => {
    const program = new Command();
    program.addCommand(snapshotCommand(runningDeps(port)));
    const logs = await captureLogs(() => program.parseAsync(["node", "rigged", "snapshot", "list", "rig-1"]));
    const output = logs.join("\n");
    expect(output).toContain("snap-1");
    expect(output).toContain("snap-2");
    expect(output).toContain("manual");
    expect(output).toContain("complete");
  });

  // Test 4: restore prints per-node status
  it("restore: prints per-node status", async () => {
    const program = new Command();
    program.addCommand(restoreCommand(runningDeps(port)));
    const logs = await captureLogs(() => program.parseAsync(["node", "rigged", "restore", "snap-1", "--rig", "rig-1"]));
    const output = logs.join("\n");
    expect(output).toContain("orchestrator");
    expect(output).toContain("resumed");
    expect(output).toContain("worker");
    expect(output).toContain("checkpoint_written");
  });

  // Test 5: restore snapshot not found (404)
  it("restore: snapshot not found (404) -> error", async () => {
    const program = new Command();
    program.addCommand(restoreCommand(runningDeps(port)));
    const logs = await captureLogs(() => program.parseAsync(["node", "rigged", "restore", "missing", "--rig", "rig-1"]));
    expect(logs.join("\n")).toMatch(/not found/i);
  });

  // Test 6: restore in progress (409)
  it("restore: in progress (409) -> error", async () => {
    const program = new Command();
    program.addCommand(restoreCommand(runningDeps(port)));
    const logs = await captureLogs(() => program.parseAsync(["node", "rigged", "restore", "locked", "--rig", "rig-1"]));
    expect(logs.join("\n")).toMatch(/in progress/i);
  });

  // Test 7: snapshot with daemon stopped -> no HTTP
  it("snapshot: daemon stopped -> 'not running', no HTTP", async () => {
    const deps = stoppedDeps();
    const program = new Command();
    program.addCommand(snapshotCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rigged", "snapshot", "rig-1"]));
    expect(logs.join("\n")).toMatch(/not running/i);
    expect(deps.clientFactory).not.toHaveBeenCalled();
  });

  // Test 8: restore with unhealthy daemon -> no HTTP
  it("restore: unhealthy daemon -> error, no HTTP", async () => {
    const deps = unhealthyDeps();
    const program = new Command();
    program.addCommand(restoreCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rigged", "restore", "snap-1", "--rig", "rig-1"]));
    expect(logs.join("\n")).toMatch(/unhealthy/i);
    expect(deps.clientFactory).not.toHaveBeenCalled();
  });

  // Test 9: snapshot uses stored port from daemon.json
  it("snapshot: uses stored custom port from daemon.json", async () => {
    const usedUrls: string[] = [];
    const deps: StatusDeps = {
      lifecycleDeps: mockLifecycleDeps({
        exists: vi.fn((p: string) => p === STATE_FILE),
        readFile: vi.fn((p: string) => {
          if (p === STATE_FILE) return JSON.stringify(runningState(port));
          return null;
        }),
        fetch: vi.fn(async () => ({ ok: true })),
      }),
      clientFactory: (baseUrl) => {
        usedUrls.push(baseUrl);
        return new DaemonClient(baseUrl);
      },
    };

    const program = new Command();
    program.addCommand(snapshotCommand(deps));
    await captureLogs(() => program.parseAsync(["node", "rigged", "snapshot", "rig-1"]));

    expect(usedUrls[0]).toBe(`http://localhost:${port}`);
  });

  // Test 10: createProgram: both snapshot AND restore mounted
  it("createProgram mounts both snapshot and restore commands", async () => {
    const { createProgram } = await import("../src/index.js");
    const deps = stoppedDeps();
    const program = createProgram({ snapshotDeps: deps, restoreDeps: deps });

    // Prove snapshot is mounted
    const snapLogs = await captureLogs(() => program.parseAsync(["node", "rigged", "snapshot", "x"]));
    expect(snapLogs.join("\n")).toMatch(/not running/i);

    // Prove restore is mounted (re-create program since Commander consumes parseAsync)
    const program2 = createProgram({ snapshotDeps: deps, restoreDeps: deps });
    const restoreLogs = await captureLogs(() => program2.parseAsync(["node", "rigged", "restore", "snap-1", "--rig", "x"]));
    expect(restoreLogs.join("\n")).toMatch(/not running/i);
  });

  // Test 11: snapshot 500 -> generic error
  it("snapshot: 500 -> generic error message", async () => {
    const program = new Command();
    program.addCommand(snapshotCommand(runningDeps(port)));
    const logs = await captureLogs(() => program.parseAsync(["node", "rigged", "snapshot", "broken"]));
    expect(logs.join("\n")).toMatch(/failed|error/i);
  });

  // Test 12: restore with daemon stopped -> no HTTP (symmetric with test 7)
  it("restore: daemon stopped -> 'not running', no HTTP", async () => {
    const deps = stoppedDeps();
    const program = new Command();
    program.addCommand(restoreCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rigged", "restore", "snap-1", "--rig", "rig-1"]));
    expect(logs.join("\n")).toMatch(/not running/i);
    expect(deps.clientFactory).not.toHaveBeenCalled();
  });
});
