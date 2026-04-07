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
  let nodesData: Record<string, unknown[]>;

  beforeAll(async () => {
    psData = [];
    nodesData = {};
    server = http.createServer(async (req, res) => {
      if (req.url === "/api/ps" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(psData));
      } else if (req.url?.match(/^\/api\/rigs\/([^/]+)\/nodes$/) && req.method === "GET") {
        const rigId = decodeURIComponent(req.url.match(/^\/api\/rigs\/([^/]+)\/nodes$/)![1]!);
        if (rigId in nodesData) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(nodesData[rigId]));
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Rig "${rigId}" not found` }));
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
      await makeCmd().parseAsync(["node", "rig", "ps"]);
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
      await makeCmd().parseAsync(["node", "rig", "ps", "--json"]);
    });
    const parsed = JSON.parse(logs.join(""));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].rigId).toBe("rig-1");
  });

  // T11: ps empty -> 'No rigs'
  it("ps with no rigs prints No rigs", async () => {
    psData = [];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps"]);
    });
    expect(logs.some((l) => l.includes("No rigs"))).toBe(true);
  });

  // NS-T08: ps --nodes tests

  it("ps --nodes formats table with rig context and restore columns", async () => {
    psData = [
      { rigId: "rig-1", name: "test-rig", nodeCount: 2, runningCount: 2, status: "running", uptime: "1h", latestSnapshot: null },
    ];
    nodesData["rig-1"] = [
      {
        rigId: "rig-1", rigName: "test-rig", logicalId: "dev.impl", podId: "pod-1",
        canonicalSessionName: "dev-impl@test-rig", nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a",
        tmuxAttachCommand: "tmux attach -t dev-impl@test-rig", resumeCommand: null, latestError: null,
      },
      {
        rigId: "rig-1", rigName: "test-rig", logicalId: "infra.server", podId: "pod-1",
        canonicalSessionName: "infra-server@test-rig", nodeKind: "infrastructure", runtime: "terminal",
        sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a",
        tmuxAttachCommand: "tmux attach -t infra-server@test-rig", resumeCommand: null, latestError: null,
      },
    ];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("RIG");
    expect(output).toContain("POD");
    expect(output).toContain("MEMBER");
    expect(output).toContain("SESSION");
    expect(output).toContain("RUNTIME");
    expect(output).toContain("RESTORE");
    expect(output).toContain("test-rig#rig-1");
    expect(output).toContain("dev-impl@test-rig");
    expect(output).toContain("terminal");
  });

  it("ps --nodes includes rig identifiers so duplicate rig names stay distinguishable", async () => {
    psData = [
      { rigId: "rig-old", name: "demo-rig", nodeCount: 1, runningCount: 0, status: "stopped", uptime: null, latestSnapshot: "1m ago" },
      { rigId: "rig-new", name: "demo-rig", nodeCount: 1, runningCount: 1, status: "running", uptime: "10s", latestSnapshot: null },
    ];
    nodesData["rig-old"] = [
      {
        rigId: "rig-old", rigName: "demo-rig", logicalId: "dev.impl", podId: "pod-1",
        canonicalSessionName: "dev-impl@demo-rig", nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "exited", startupStatus: "failed", restoreOutcome: "failed",
        tmuxAttachCommand: null, resumeCommand: null, latestError: "old restore failed",
      },
    ];
    nodesData["rig-new"] = [
      {
        rigId: "rig-new", rigName: "demo-rig", logicalId: "dev.impl", podId: "pod-2",
        canonicalSessionName: "dev-impl@demo-rig", nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a",
        tmuxAttachCommand: null, resumeCommand: null, latestError: null,
      },
    ];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("demo-rig#rig-old");
    expect(output).toContain("demo-rig#rig-new");
  });

  it("ps --nodes --json produces valid JSON array with restoreOutcome", async () => {
    psData = [
      { rigId: "rig-1", name: "test-rig", nodeCount: 1, runningCount: 1, status: "running", uptime: "1m", latestSnapshot: null },
    ];
    nodesData["rig-1"] = [
      {
        rigId: "rig-1", rigName: "test-rig", logicalId: "dev.impl", podId: "pod-1",
        canonicalSessionName: "dev-impl@test-rig", nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "running", startupStatus: "ready", restoreOutcome: "resumed",
        tmuxAttachCommand: null, resumeCommand: null, latestError: null,
      },
    ];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json"]);
    });
    const parsed = JSON.parse(logs.join(""));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].restoreOutcome).toBe("resumed");
    expect(parsed[0].nodeKind).toBe("agent");
  });

  it("ps --nodes includes infrastructure nodes", async () => {
    psData = [
      { rigId: "rig-1", name: "test-rig", nodeCount: 1, runningCount: 1, status: "running", uptime: "1m", latestSnapshot: null },
    ];
    nodesData["rig-1"] = [
      {
        rigId: "rig-1", rigName: "test-rig", logicalId: "infra.daemon", podId: "pod-1",
        canonicalSessionName: "infra-daemon@test-rig", nodeKind: "infrastructure", runtime: "terminal",
        sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a",
        tmuxAttachCommand: null, resumeCommand: null, latestError: null,
      },
    ];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("infra");
    expect(output).toContain("terminal");
  });

  it("ps (no flag) still works backward compatible", async () => {
    psData = [
      { rigId: "rig-1", name: "compat-rig", nodeCount: 1, runningCount: 1, status: "running", uptime: "5m", latestSnapshot: null },
    ];
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("compat-rig");
    expect(output).toContain("RIG");
    expect(exitCode).toBeUndefined();
  });

  it("ps help text includes examples and exit codes", () => {
    const psCmd = psCommand(runningDeps(port));
    let helpOutput = "";
    psCmd.configureOutput({ writeOut: (s) => { helpOutput += s; } });
    psCmd.outputHelp();
    expect(helpOutput).toContain("rig ps --nodes");
    expect(helpOutput).toContain("Exit codes");
  });

  it("ps --nodes warns on per-rig fetch failure", async () => {
    psData = [
      { rigId: "nonexistent", name: "bad-rig", nodeCount: 1, runningCount: 0, status: "stopped", uptime: null, latestSnapshot: null },
    ];
    nodesData = {}; // no nodes data → server returns 404
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("Warning");
    expect(output).toContain("bad-rig");
  });

  it("daemon not running error includes guidance", async () => {
    const stoppedDeps: StatusDeps = {
      lifecycleDeps: mockLifecycleDeps(),
      clientFactory: (baseUrl) => new DaemonClient(baseUrl),
    };
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(psCommand(stoppedDeps));
    const { logs, exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "ps"]);
    });
    expect(logs.some((l) => l.includes("rig daemon start"))).toBe(true);
    expect(exitCode).toBe(1);
  });
});
