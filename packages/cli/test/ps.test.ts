import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { psCommand } from "../src/commands/ps.js";
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

describe("Ps CLI", () => {
  let server: http.Server;
  let port: number;
  let psData: unknown[];

  beforeAll(async () => {
    psData = [];
    server = http.createServer(async (req, res) => {
      if (req.url === "/api/ps" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(psData));
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
    prog.addCommand(psCommand(runningDeps(port)));
    return prog;
  }

  // T9: ps table output with rigs
  it("ps prints formatted table", async () => {
    psData = [
      { rigId: "rig-1", name: "review-rig", nodeCount: 3, runningCount: 3, status: "running", uptime: "2h 15m", latestSnapshot: "5m ago" },
      { rigId: "rig-2", name: "dev-rig", nodeCount: 2, runningCount: 0, status: "stopped", uptime: null, latestSnapshot: "1d ago" },
    ];
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "ps"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("RIG");
    expect(output).toContain("NODES");
    expect(output).toContain("RUNNING");
    expect(output).toContain("STATUS");
    expect(output).toContain("review-rig");
    expect(output).toContain("dev-rig");
    expect(output).toContain("running");
    expect(output).toContain("stopped");
    expect(exitCode).toBeUndefined(); // 0
  });

  // T10: ps --json outputs PsEntry[]
  it("ps --json outputs parseable JSON array", async () => {
    psData = [
      { rigId: "rig-1", name: "test", nodeCount: 1, runningCount: 1, status: "running", uptime: "1m", latestSnapshot: null },
    ];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "ps", "--json"]);
    });
    const parsed = JSON.parse(logs.join(""));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].rigId).toBe("rig-1");
  });

  // T11: ps empty -> 'No rigs'
  it("ps with no rigs prints No rigs", async () => {
    psData = [];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "ps"]);
    });
    expect(logs.some((l) => l.includes("No rigs"))).toBe(true);
  });
});
