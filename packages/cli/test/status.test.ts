import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { statusCommand, type StatusDeps } from "../src/commands/status.js";
import { DaemonClient } from "../src/client.js";
import {
  STATE_FILE,
  type LifecycleDeps,
  type DaemonState,
} from "../src/daemon-lifecycle.js";

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
    try {
      await fn();
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    resolve(logs);
  });
}

// Echo server for daemon API
function createDaemonServer(summaryData: unknown[], cmuxStatus: unknown) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");

    if (url.pathname === "/api/rigs/summary") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(summaryData));
      return;
    }
    if (url.pathname === "/api/adapters/cmux/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(cmuxStatus));
      return;
    }
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
    port: 0,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    listen: () => new Promise<number>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolve(port);
      });
    }),
  };
}

function runningState(port: number): DaemonState {
  return { pid: 123, port, db: "test.sqlite", startedAt: "2026-03-24T00:00:00Z" };
}

describe("rigged status", () => {
  // Test 1: Running daemon with rigs -> formatted summary
  describe("with running daemon and rigs", () => {
    let srv: ReturnType<typeof createDaemonServer>;
    let port: number;

    beforeAll(async () => {
      srv = createDaemonServer(
        [
          { id: "r1", name: "alpha", nodeCount: 3, latestSnapshotAt: "2026-03-24 01:00:00", latestSnapshotId: "snap-1" },
          { id: "r2", name: "beta", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null },
        ],
        { available: true },
      );
      port = await srv.listen();
    });
    afterAll(async () => { await srv.close(); });

    it("formats rig summary with node counts and snapshot info", async () => {
      const deps: StatusDeps = {
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

      const program = new Command();
      program.addCommand(statusCommand(deps));
      const logs = await captureLogs(() => program.parseAsync(["node", "rigged", "status"]));
      const output = logs.join("\n");

      expect(output).toContain("alpha");
      expect(output).toContain("3");
      expect(output).toContain("beta");
      expect(output).toContain("1");
      // Must include snapshot age info
      expect(output).toMatch(/snapshot:/i);
    });
  });

  // Test 2: Running daemon with no rigs -> 'No rigs'
  describe("with running daemon and no rigs", () => {
    let srv: ReturnType<typeof createDaemonServer>;
    let port: number;

    beforeAll(async () => {
      srv = createDaemonServer([], { available: false });
      port = await srv.listen();
    });
    afterAll(async () => { await srv.close(); });

    it("shows 'No rigs' message", async () => {
      const deps: StatusDeps = {
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

      const program = new Command();
      program.addCommand(statusCommand(deps));
      const logs = await captureLogs(() => program.parseAsync(["node", "rigged", "status"]));

      expect(logs.join("\n")).toMatch(/no rigs/i);
    });
  });

  // Test 3: Daemon stopped (no daemon.json) -> 'Daemon not running', no HTTP
  it("stopped daemon -> 'Daemon not running', no HTTP calls", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true }));
    const clientFactory = vi.fn();
    const deps: StatusDeps = {
      lifecycleDeps: mockLifecycleDeps({
        exists: vi.fn(() => false),
        fetch: fetchFn,
      }),
      clientFactory: clientFactory as unknown as StatusDeps["clientFactory"],
    };

    const program = new Command();
    program.addCommand(statusCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rigged", "status"]));

    expect(logs.join("\n")).toMatch(/not running/i);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  // Test 4: Daemon stale (pid dead) -> 'Daemon not running', no HTTP
  it("stale daemon -> 'Daemon not running', no HTTP calls", async () => {
    const clientFactory = vi.fn();
    const deps: StatusDeps = {
      lifecycleDeps: mockLifecycleDeps({
        exists: vi.fn((p: string) => p === STATE_FILE),
        readFile: vi.fn((p: string) => {
          if (p === STATE_FILE) return JSON.stringify(runningState(7433));
          return null;
        }),
        isProcessAlive: vi.fn(() => false), // pid dead -> stale
      }),
      clientFactory: clientFactory as unknown as StatusDeps["clientFactory"],
    };

    const program = new Command();
    program.addCommand(statusCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rigged", "status"]));

    expect(logs.join("\n")).toMatch(/not running/i);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  // Test 5: Output includes cmux status
  describe("cmux status in output", () => {
    let srv: ReturnType<typeof createDaemonServer>;
    let port: number;

    beforeAll(async () => {
      srv = createDaemonServer(
        [{ id: "r1", name: "alpha", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null }],
        { available: true },
      );
      port = await srv.listen();
    });
    afterAll(async () => { await srv.close(); });

    it("includes cmux status line", async () => {
      const deps: StatusDeps = {
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

      const program = new Command();
      program.addCommand(statusCommand(deps));
      const logs = await captureLogs(() => program.parseAsync(["node", "rigged", "status"]));

      expect(logs.join("\n")).toMatch(/cmux/i);
    });
  });

  // Test 6: Uses stored custom port from daemon.json
  describe("custom port", () => {
    let srv: ReturnType<typeof createDaemonServer>;
    let port: number;

    beforeAll(async () => {
      srv = createDaemonServer([], { available: false });
      port = await srv.listen();
    });
    afterAll(async () => { await srv.close(); });

    it("constructs DaemonClient with stored port, not default", async () => {
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
      program.addCommand(statusCommand(deps));
      await captureLogs(() => program.parseAsync(["node", "rigged", "status"]));

      expect(usedUrls[0]).toBe(`http://127.0.0.1:${port}`);
      expect(usedUrls[0]).not.toBe("http://127.0.0.1:7433");
    });
  });

  // Test 7: Running but healthy=false -> degraded message, no summary/cmux HTTP
  it("unhealthy daemon -> degraded message, no DaemonClient calls", async () => {
    const clientFactory = vi.fn();
    const deps: StatusDeps = {
      lifecycleDeps: mockLifecycleDeps({
        exists: vi.fn((p: string) => p === STATE_FILE),
        readFile: vi.fn((p: string) => {
          if (p === STATE_FILE) return JSON.stringify(runningState(7433));
          return null;
        }),
        isProcessAlive: vi.fn(() => true),
        fetch: vi.fn(async () => { throw new Error("connection refused"); }), // healthz fails
      }),
      clientFactory: clientFactory as unknown as StatusDeps["clientFactory"],
    };

    const program = new Command();
    program.addCommand(statusCommand(deps));
    const logs = await captureLogs(() => program.parseAsync(["node", "rigged", "status"]));

    expect(logs.join("\n")).toMatch(/unhealthy|healthz failed/i);
    expect(clientFactory).not.toHaveBeenCalled();
  });

  // Test 8: root-level rigged status is mounted (uses real createProgram from index.ts)
  it("rigged status is wired via createProgram (real index.ts wiring)", async () => {
    const { createProgram } = await import("../src/index.js");

    const statusDeps: StatusDeps = {
      lifecycleDeps: mockLifecycleDeps({ exists: vi.fn(() => false) }),
      clientFactory: vi.fn() as unknown as StatusDeps["clientFactory"],
    };

    const program = createProgram({ statusDeps });

    const logs = await captureLogs(() => program.parseAsync(["node", "rigged", "status"]));

    // Should have output (not crash or "unknown command")
    expect(logs.join("\n")).toMatch(/not running/i);
  });

  // Test 9: summary 500 -> error message, does not crash
  describe("summary returns 500", () => {
    let srv: ReturnType<typeof createDaemonServer>;
    let port: number;

    beforeAll(async () => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url!, "http://localhost");
        if (url.pathname === "/api/rigs/summary") {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal" }));
          return;
        }
        if (url.pathname === "/healthz") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
      srv = {
        server,
        port: 0,
        close: () => new Promise<void>((r) => server.close(() => r())),
        listen: () => new Promise<number>((r) => {
          server.listen(0, () => {
            const addr = server.address();
            r(typeof addr === "object" && addr ? addr.port : 0);
          });
        }),
      };
      port = await srv.listen();
    });
    afterAll(async () => { await srv.close(); });

    it("summary 500 -> error message, no crash", async () => {
      const deps: StatusDeps = {
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

      const program = new Command();
      program.addCommand(statusCommand(deps));
      const logs = await captureLogs(() => program.parseAsync(["node", "rigged", "status"]));

      expect(logs.join("\n")).toMatch(/failed.*summary|HTTP 500/i);
    });
  });
});
