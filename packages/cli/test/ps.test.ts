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

  it("ps recovers when daemon.json is missing but configured daemon is healthy", async () => {
    const savedPort = process.env["OPENRIG_PORT"];
    const savedHost = process.env["OPENRIG_HOST"];
    process.env["OPENRIG_PORT"] = String(port);
    process.env["OPENRIG_HOST"] = "127.0.0.1";
    try {
      psData = [
        { rigId: "rig-1", name: "recovered-rig", nodeCount: 1, runningCount: 1, status: "running", uptime: "15s", latestSnapshot: null },
      ];
      const prog = new Command();
      prog.exitOverride();
      prog.addCommand(psCommand({
        lifecycleDeps: mockLifecycleDeps({
          exists: vi.fn(() => false),
          fetch: vi.fn(async (url: string) => {
            expect(url).toBe(`http://127.0.0.1:${port}/healthz`);
            return { ok: true };
          }),
        }),
        clientFactory: (baseUrl) => new DaemonClient(baseUrl),
      }));

      const { logs, exitCode } = await captureLogs(async () => {
        await prog.parseAsync(["node", "rig", "ps"]);
      });
      const output = logs.join("\n");
      expect(output).toContain("recovered-rig");
      expect(output).not.toMatch(/Daemon not running/i);
      expect(exitCode).toBeUndefined();
    } finally {
      if (savedPort === undefined) delete process.env["OPENRIG_PORT"];
      else process.env["OPENRIG_PORT"] = savedPort;
      if (savedHost === undefined) delete process.env["OPENRIG_HOST"];
      else process.env["OPENRIG_HOST"] = savedHost;
    }
  });

  // NS-T08: ps --nodes tests

  it("ps --nodes formats table with rig context and restore columns", async () => {
    psData = [
      { rigId: "rig-1", name: "test-rig", nodeCount: 2, runningCount: 2, status: "running", uptime: "1h", latestSnapshot: null },
    ];
    nodesData["rig-1"] = [
      {
        rigId: "rig-1", rigName: "test-rig", logicalId: "dev.impl", podId: "pod-1", podNamespace: "dev",
        canonicalSessionName: "dev-impl@test-rig", nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a",
        tmuxAttachCommand: "tmux attach -t dev-impl@test-rig", resumeCommand: null, latestError: null,
      },
      {
        rigId: "rig-1", rigName: "test-rig", logicalId: "infra.server", podId: "pod-1", podNamespace: "dev",
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
        rigId: "rig-old", rigName: "demo-rig", logicalId: "dev.impl", podId: "pod-1", podNamespace: "dev",
        canonicalSessionName: "dev-impl@demo-rig", nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "exited", startupStatus: "failed", restoreOutcome: "failed",
        tmuxAttachCommand: null, resumeCommand: null, latestError: "old restore failed",
      },
    ];
    nodesData["rig-new"] = [
      {
        rigId: "rig-new", rigName: "demo-rig", logicalId: "dev.impl", podId: "pod-2", podNamespace: "dev",
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
        rigId: "rig-1", rigName: "test-rig", logicalId: "dev.impl", podId: "pod-1", podNamespace: "dev",
        canonicalSessionName: "dev-impl@test-rig", nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "running", startupStatus: "ready", restoreOutcome: "resumed",
        tmuxAttachCommand: null, resumeCommand: null, latestError: null,
        agentActivity: {
          state: "idle",
          reason: "idle_status_bar",
          evidenceSource: "pane_heuristic",
          sampledAt: "2026-04-24T12:00:00.000Z",
          evidence: "gpt-5.5 xhigh fast · Context [████ ]",
        },
      },
    ];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json"]);
    });
    const parsed = JSON.parse(logs.join(""));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].restoreOutcome).toBe("resumed");
    expect(parsed[0].nodeKind).toBe("agent");
    expect(parsed[0].podNamespace).toBe("dev");
    expect(parsed[0].agentActivity).toMatchObject({
      state: "idle",
      reason: "idle_status_bar",
      evidenceSource: "pane_heuristic",
    });
  });

  it("ps --nodes human output shows activity as a separate runtime truth field", async () => {
    psData = [
      { rigId: "rig-1", name: "test-rig", nodeCount: 2, runningCount: 2, status: "running", uptime: "1m", latestSnapshot: null },
    ];
    nodesData["rig-1"] = [
      {
        rigId: "rig-1", rigName: "test-rig", logicalId: "dev.impl", podId: "pod-1", podNamespace: "dev",
        canonicalSessionName: "dev-impl@test-rig", nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a",
        tmuxAttachCommand: null, resumeCommand: null, latestError: null,
        agentActivity: { state: "running", reason: "mid_work_pattern", evidenceSource: "pane_heuristic", sampledAt: "2026-04-24T12:00:00.000Z", evidence: "Working" },
      },
      {
        rigId: "rig-1", rigName: "test-rig", logicalId: "dev.qa", podId: "pod-1", podNamespace: "dev",
        canonicalSessionName: "dev-qa@test-rig", nodeKind: "agent", runtime: "codex",
        sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a",
        tmuxAttachCommand: null, resumeCommand: null, latestError: null,
        agentActivity: { state: "unknown", reason: "capture_failed", evidenceSource: "pane_heuristic", sampledAt: "2026-04-24T12:00:00.000Z", evidence: null },
      },
    ];

    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes"]);
    });

    const output = logs.join("\n");
    expect(output).toContain("ACTIVITY");
    expect(output).toContain("running");
    expect(output).toContain("unknown");
    expect(output).toContain("dev-impl@test-rig");
  });

  it("ps --nodes includes infrastructure nodes", async () => {
    psData = [
      { rigId: "rig-1", name: "test-rig", nodeCount: 1, runningCount: 1, status: "running", uptime: "1m", latestSnapshot: null },
    ];
    nodesData["rig-1"] = [
      {
        rigId: "rig-1", rigName: "test-rig", logicalId: "infra.daemon", podId: "pod-1", podNamespace: "infra",
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

  it("ps --nodes truncates long rig and session names so the table stays aligned", async () => {
    psData = [
      {
        rigId: "rig-very-long-id-1234567890",
        name: "rigged-buildout-with-an-extremely-long-name",
        nodeCount: 1,
        runningCount: 1,
        status: "running",
        uptime: "1m",
        latestSnapshot: null,
      },
    ];
    nodesData["rig-very-long-id-1234567890"] = [
      {
        rigId: "rig-very-long-id-1234567890",
        rigName: "rigged-buildout-with-an-extremely-long-name",
        logicalId: "research1.analyst",
        podId: "pod-research",
        podNamespace: "research1",
        canonicalSessionName: "research1-analyst-with-an-extremely-long-session-name@rigged-buildout-with-an-extremely-long-name",
        nodeKind: "agent",
        runtime: "claude-code",
        sessionStatus: "running",
        startupStatus: "ready",
        restoreOutcome: "n-a",
        tmuxAttachCommand: null,
        resumeCommand: null,
        latestError: null,
      },
    ];

    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes"]);
    });
    const lines = logs.join("\n").split("\n");
    expect(lines[1]).toContain("…");
    expect(lines[1]!.length).toBeLessThan(180);
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
      lifecycleDeps: mockLifecycleDeps({
        fetch: vi.fn(async () => { throw new Error("refused"); }),
      }),
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

  // L2 lifecycle column / JSON shape (rig + node level)
  it("ps prints LIFECYCLE column with abbreviated rig-level state", async () => {
    psData = [
      { rigId: "rig-1", name: "running-rig", nodeCount: 2, runningCount: 2, status: "running", lifecycleState: "running", uptime: "2h", latestSnapshot: null },
      { rigId: "rig-2", name: "recover-rig", nodeCount: 2, runningCount: 0, status: "stopped", lifecycleState: "recoverable", uptime: null, latestSnapshot: "1h ago" },
      { rigId: "rig-3", name: "stop-rig", nodeCount: 1, runningCount: 0, status: "stopped", lifecycleState: "stopped", uptime: null, latestSnapshot: null },
      { rigId: "rig-4", name: "deg-rig", nodeCount: 2, runningCount: 1, status: "partial", lifecycleState: "degraded", uptime: "30m", latestSnapshot: null },
      { rigId: "rig-5", name: "att-rig", nodeCount: 2, runningCount: 2, status: "running", lifecycleState: "attention_required", uptime: "10m", latestSnapshot: null },
    ];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("LIFECYCLE");
    expect(output).toContain("run");
    expect(output).toContain("rec");
    expect(output).toContain("stp");
    expect(output).toContain("deg");
    expect(output).toContain("att");
  });

  it("ps --json includes lifecycleState in rig entries", async () => {
    psData = [
      { rigId: "rig-1", name: "test", nodeCount: 1, runningCount: 0, status: "stopped", lifecycleState: "recoverable", uptime: null, latestSnapshot: "5m ago" },
    ];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--json"]);
    });
    const parsed = JSON.parse(logs.join(""));
    expect(parsed[0].lifecycleState).toBe("recoverable");
  });

  it("ps --nodes prints LIFECYCLE column with per-node abbreviated state", async () => {
    psData = [
      { rigId: "rig-1", name: "mixed-rig", nodeCount: 3, runningCount: 1, status: "partial", lifecycleState: "degraded", uptime: "15m", latestSnapshot: null },
    ];
    nodesData["rig-1"] = [
      {
        rigId: "rig-1", rigName: "mixed-rig", logicalId: "dev.impl", podId: "pod-1", podNamespace: "dev",
        canonicalSessionName: "dev-impl@mixed-rig", nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a", lifecycleState: "running",
        tmuxAttachCommand: null, resumeCommand: null, latestError: null,
      },
      {
        rigId: "rig-1", rigName: "mixed-rig", logicalId: "dev.qa", podId: "pod-1", podNamespace: "dev",
        canonicalSessionName: "dev-qa@mixed-rig", nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "detached", startupStatus: "ready", restoreOutcome: "n-a", lifecycleState: "recoverable",
        tmuxAttachCommand: null, resumeCommand: null, latestError: null,
      },
      {
        rigId: "rig-1", rigName: "mixed-rig", logicalId: "dev.lead", podId: "pod-1", podNamespace: "dev",
        canonicalSessionName: "dev-lead@mixed-rig", nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "detached", startupStatus: "ready", restoreOutcome: "n-a", lifecycleState: "detached",
        tmuxAttachCommand: null, resumeCommand: null, latestError: null,
      },
    ];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("LIFECYCLE");
    expect(output).toContain("run");
    expect(output).toContain("rec");
    expect(output).toContain("det");
  });

  it("ps --nodes --json includes lifecycleState per node", async () => {
    psData = [
      { rigId: "rig-1", name: "test", nodeCount: 1, runningCount: 0, status: "stopped", lifecycleState: "recoverable", uptime: null, latestSnapshot: null },
    ];
    nodesData["rig-1"] = [
      {
        rigId: "rig-1", rigName: "test", logicalId: "dev.impl", podId: "pod-1", podNamespace: "dev",
        canonicalSessionName: "dev-impl@test", nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "detached", startupStatus: "ready", restoreOutcome: "n-a", lifecycleState: "recoverable",
        tmuxAttachCommand: null, resumeCommand: null, latestError: null,
      },
    ];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json"]);
    });
    const parsed = JSON.parse(logs.join(""));
    expect(parsed[0].lifecycleState).toBe("recoverable");
  });

  // L3-followup: trustworthy and scale-safe rig ps.
  describe("L3-followup: trustworthy and scale-safe rig ps", () => {
    it("ps --json passes through rigName alias from server (jq '.[].rigName' regression)", async () => {
      psData = [
        { rigId: "rig-1", name: "alpha", rigName: "alpha", nodeCount: 1, runningCount: 1, status: "running", lifecycleState: "running", uptime: "1m", latestSnapshot: null },
      ];
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--json"]);
      });
      const parsed = JSON.parse(logs.join(""));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].name).toBe("alpha");
      expect(parsed[0].rigName).toBe("alpha");
    });

    it("ps --json without flags emits a bare array (back-compat)", async () => {
      psData = [
        { rigId: "rig-1", name: "alpha", rigName: "alpha", nodeCount: 1, runningCount: 1, status: "running", lifecycleState: "running", uptime: "1m", latestSnapshot: null },
        { rigId: "rig-2", name: "beta", rigName: "beta", nodeCount: 1, runningCount: 0, status: "stopped", lifecycleState: "stopped", uptime: null, latestSnapshot: null },
      ];
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--json"]);
      });
      const parsed = JSON.parse(logs.join(""));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
    });

    it("ps --json --limit emits envelope shape with truncated/totalRigs/hint", async () => {
      psData = Array.from({ length: 10 }, (_, i) => ({
        rigId: `rig-${i}`, name: `r${i}`, rigName: `r${i}`,
        nodeCount: 1, runningCount: 1, status: "running" as const, lifecycleState: "running" as const,
        uptime: "1m", latestSnapshot: null,
      }));
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--json", "--limit", "3"]);
      });
      const parsed = JSON.parse(logs.join(""));
      expect(Array.isArray(parsed)).toBe(false);
      expect(parsed.entries).toHaveLength(3);
      expect(parsed.totalRigs).toBe(10);
      expect(parsed.truncated).toBe(true);
      expect(parsed.hint).toContain("--full");
    });

    it("ps --json --fields projects only named fields", async () => {
      psData = [
        { rigId: "rig-1", name: "alpha", rigName: "alpha", nodeCount: 2, runningCount: 1, status: "partial", lifecycleState: "degraded", uptime: "1m", latestSnapshot: null },
      ];
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--json", "--fields", "rigName,status,lifecycleState"]);
      });
      const parsed = JSON.parse(logs.join(""));
      // Envelope (because --fields specified)
      expect(parsed.entries[0]).toEqual({ rigName: "alpha", status: "partial", lifecycleState: "degraded" });
      expect(parsed.entries[0].nodeCount).toBeUndefined();
    });

    it("ps --json --summary emits aggregate-only shape", async () => {
      psData = [
        { rigId: "rig-1", name: "a", rigName: "a", nodeCount: 1, runningCount: 1, status: "running", lifecycleState: "running", uptime: "1m", latestSnapshot: null },
        { rigId: "rig-2", name: "b", rigName: "b", nodeCount: 1, runningCount: 0, status: "stopped", lifecycleState: "stopped", uptime: null, latestSnapshot: null },
        { rigId: "rig-3", name: "c", rigName: "c", nodeCount: 1, runningCount: 0, status: "stopped", lifecycleState: "attention_required", uptime: null, latestSnapshot: null },
      ];
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--json", "--summary"]);
      });
      const parsed = JSON.parse(logs.join(""));
      expect(parsed.totalRigs).toBe(3);
      expect(parsed.totalRunning).toBe(1);
      expect(parsed.byLifecycle.running).toBe(1);
      expect(parsed.byLifecycle.stopped).toBe(1);
      expect(parsed.byLifecycle.attention_required).toBe(1);
      expect(parsed.entries).toBeUndefined();
    });

    it("ps --filter status=running narrows entries", async () => {
      psData = [
        { rigId: "rig-1", name: "a", rigName: "a", nodeCount: 1, runningCount: 1, status: "running", lifecycleState: "running", uptime: "1m", latestSnapshot: null },
        { rigId: "rig-2", name: "b", rigName: "b", nodeCount: 1, runningCount: 0, status: "stopped", lifecycleState: "stopped", uptime: null, latestSnapshot: null },
      ];
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--json", "--filter", "status=running"]);
      });
      const parsed = JSON.parse(logs.join(""));
      // Envelope because --filter specified
      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0].name).toBe("a");
    });

    it("ps --filter lifecycleState=attention_required narrows entries", async () => {
      psData = [
        { rigId: "rig-1", name: "a", rigName: "a", nodeCount: 1, runningCount: 1, status: "running", lifecycleState: "running", uptime: "1m", latestSnapshot: null },
        { rigId: "rig-2", name: "b", rigName: "b", nodeCount: 1, runningCount: 1, status: "running", lifecycleState: "attention_required", uptime: "1m", latestSnapshot: null },
      ];
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--json", "--filter", "lifecycleState=attention_required"]);
      });
      const parsed = JSON.parse(logs.join(""));
      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0].lifecycleState).toBe("attention_required");
    });

    it("ps --filter rejects unknown keys with actionable error and exits 1", async () => {
      psData = [];
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--json", "--filter", "unknown=foo"]);
      });
      expect(logs.some((l) => l.includes("Unknown --filter key 'unknown'"))).toBe(true);
      expect(logs.some((l) => l.includes("Supported:"))).toBe(true);
      expect(exitCode).toBe(1);
    });

    it("ps --filter rejects malformed value (no '=') and exits 1", async () => {
      psData = [];
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--json", "--filter", "noequals"]);
      });
      // PL-012: error message now names the comparator family since
      // numeric ops (>=, >, <=, <, =) are accepted.
      expect(logs.some((l) => l.includes("--filter must be key") && l.includes("op = "))).toBe(true);
      expect(exitCode).toBe(1);
    });

    it("ps --limit rejects non-numeric values and exits 1", async () => {
      psData = [];
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--json", "--limit", "abc"]);
      });
      expect(logs.some((l) => l.includes("--limit must be a non-negative integer"))).toBe(true);
      expect(exitCode).toBe(1);
    });

    // C9a: --fields UX rejection alignment with --filter pattern.

    it("ps --json --fields rejects unknown field with sorted supported list (rig-level)", async () => {
      psData = [];
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--json", "--fields", "rigId,bogus"]);
      });
      const stderr = logs.join("\n");
      expect(stderr).toContain("Unknown --fields key 'bogus'");
      expect(stderr).toContain("Supported:");
      // Sorted rig-level allow-list keys appear in the message.
      expect(stderr).toContain("latestSnapshot");
      expect(stderr).toContain("rigName");
      expect(stderr).toContain("nodeCount");
      expect(exitCode).toBe(1);
    });

    it("ps --json --fields rejects multiple unknown fields with 'keys' plural", async () => {
      psData = [];
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--json", "--fields", "foo,bar"]);
      });
      const stderr = logs.join("\n");
      expect(stderr).toContain("Unknown --fields keys 'foo', 'bar'");
      expect(exitCode).toBe(1);
    });

    it("ps --json --fields rejects empty string and exits 1", async () => {
      psData = [];
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--json", "--fields", ""]);
      });
      expect(logs.some((l) => l.includes("--fields cannot be empty"))).toBe(true);
      expect(exitCode).toBe(1);
    });

    it("ps --json --fields rejects whitespace-only-after-trim and exits 1", async () => {
      psData = [];
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--json", "--fields", ",,"]);
      });
      expect(logs.some((l) => l.includes("--fields cannot be empty"))).toBe(true);
      expect(exitCode).toBe(1);
    });

    it("ps --json --fields rejects node-only field at rig-level (logicalId)", async () => {
      psData = [];
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--json", "--fields", "rigId,logicalId"]);
      });
      expect(logs.some((l) => l.includes("Unknown --fields key 'logicalId'"))).toBe(true);
      expect(exitCode).toBe(1);
    });

    it("ps --json --fields accepts both name AND rigName at rig-level (aliasing preserved per 0a9fb43)", async () => {
      psData = [
        { rigId: "rig-1", name: "alpha", rigName: "alpha", nodeCount: 1, runningCount: 1, status: "running", lifecycleState: "running", uptime: "1m", latestSnapshot: null },
      ];
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--json", "--fields", "name,rigName"]);
      });
      expect(exitCode).not.toBe(1);
      const parsed = JSON.parse(logs.join(""));
      expect(parsed.entries[0]).toEqual({ name: "alpha", rigName: "alpha" });
    });

    it("ps --nodes --json --fields rejects 'name' with rigName hint (load-bearing aliasing decision)", async () => {
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--fields", "name,logicalId"]);
      });
      const stderr = logs.join("\n");
      expect(stderr).toContain("Unknown --fields key 'name'");
      expect(stderr).toContain("Hint: 'name' is a rig-level field; use 'rigName' for node entries.");
      expect(exitCode).toBe(1);
    });

    it("ps --nodes --json --fields rejects bogus key with sorted node-level supported list", async () => {
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--fields", "rigName,bogus"]);
      });
      const stderr = logs.join("\n");
      expect(stderr).toContain("Unknown --fields key 'bogus'");
      expect(stderr).toContain("Supported:");
      // Sorted node-level allow-list — node-level-only key must be present.
      expect(stderr).toContain("agentActivity");
      expect(stderr).toContain("logicalId");
      // Rig-level-only key must NOT be in the node-level supported list.
      expect(stderr).not.toMatch(/Supported:[^.]*\bname\b/);
      expect(exitCode).toBe(1);
    });

    it("ps --filter rejection still works after --fields rejection wired in (regression)", async () => {
      psData = [];
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--json", "--filter", "unknown=v"]);
      });
      expect(logs.some((l) => l.includes("Unknown --filter key 'unknown'"))).toBe(true);
      expect(exitCode).toBe(1);
    });

    it("ps --filter status=running --fields rigName combined still works (regression)", async () => {
      psData = [
        { rigId: "rig-1", name: "a", rigName: "a", nodeCount: 1, runningCount: 1, status: "running", lifecycleState: "running", uptime: "1m", latestSnapshot: null },
        { rigId: "rig-2", name: "b", rigName: "b", nodeCount: 1, runningCount: 0, status: "stopped", lifecycleState: "stopped", uptime: null, latestSnapshot: null },
      ];
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--json", "--filter", "status=running", "--fields", "rigName,status"]);
      });
      expect(exitCode).not.toBe(1);
      const parsed = JSON.parse(logs.join(""));
      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0]).toEqual({ rigName: "a", status: "running" });
    });

    // Synthetic large-host fixture: 60 rigs (just over default 50 budget) is
    // the smallest fixture that proves human-truncation behavior. Per Amendment
    // C: the L4 proof already exercised real 100x10 scale; this test asserts
    // the truncation path fires and the footer is honest. Using 60 instead of
    // 100 keeps the test fast while still proving the budget boundary.
    it("ps human output truncates above HUMAN_RIG_BUDGET (50) with honest footer (Amendment C)", async () => {
      psData = Array.from({ length: 60 }, (_, i) => ({
        rigId: `rig-${String(i).padStart(2, "0")}`,
        name: `r${String(i).padStart(2, "0")}`,
        rigName: `r${String(i).padStart(2, "0")}`,
        nodeCount: 1, runningCount: 1, status: "running" as const, lifecycleState: "running" as const,
        uptime: "1m", latestSnapshot: null,
      }));
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps"]);
      });
      const output = logs.join("\n");

      // Header present
      expect(output).toContain("LIFECYCLE");
      // First 50 rig names visible
      expect(output).toContain("r00");
      expect(output).toContain("r49");
      // Beyond-budget rigs not in default human output
      expect(output).not.toContain("r59");
      // Truncation footer with actual remaining count
      expect(output).toMatch(/and 10 more rigs \(truncated at 50\)/);
      expect(output).toContain("rig ps --full");
    });

    it("ps --full disables human truncation; all 60 rigs printed", async () => {
      psData = Array.from({ length: 60 }, (_, i) => ({
        rigId: `rig-${i}`, name: `r${i}`, rigName: `r${i}`,
        nodeCount: 1, runningCount: 1, status: "running" as const, lifecycleState: "running" as const,
        uptime: "1m", latestSnapshot: null,
      }));
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--full"]);
      });
      const output = logs.join("\n");
      expect(output).toContain("r0");
      expect(output).toContain("r59");
      expect(output).not.toMatch(/truncated/);
    });

    it("ps --json default unbounded for large rigs: emits all 60 entries (back-compat)", async () => {
      psData = Array.from({ length: 60 }, (_, i) => ({
        rigId: `rig-${i}`, name: `r${i}`, rigName: `r${i}`,
        nodeCount: 1, runningCount: 1, status: "running" as const, lifecycleState: "running" as const,
        uptime: "1m", latestSnapshot: null,
      }));
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--json"]);
      });
      const parsed = JSON.parse(logs.join(""));
      // Default JSON stays a bare array of all 60; NO envelope.
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(60);
    });

    it("ps --nodes --json default unbounded: bare array (back-compat)", async () => {
      psData = [
        { rigId: "rig-1", name: "test", rigName: "test", nodeCount: 2, runningCount: 1, status: "partial", lifecycleState: "degraded", uptime: "1m", latestSnapshot: null },
      ];
      nodesData["rig-1"] = Array.from({ length: 5 }, (_, i) => ({
        rigId: "rig-1", rigName: "test", logicalId: `dev.n${i}`, podId: "pod-1", podNamespace: "dev",
        canonicalSessionName: `n${i}@test`, nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a", lifecycleState: "running",
        tmuxAttachCommand: null, resumeCommand: null, latestError: null,
      }));
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json"]);
      });
      const parsed = JSON.parse(logs.join(""));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(5);
    });

    it("ps --nodes --json --limit emits envelope shape with totalNodes/truncated/hint", async () => {
      psData = [
        { rigId: "rig-1", name: "test", rigName: "test", nodeCount: 5, runningCount: 5, status: "running", lifecycleState: "running", uptime: "1m", latestSnapshot: null },
      ];
      nodesData["rig-1"] = Array.from({ length: 5 }, (_, i) => ({
        rigId: "rig-1", rigName: "test", logicalId: `dev.n${i}`, podId: "pod-1", podNamespace: "dev",
        canonicalSessionName: `n${i}@test`, nodeKind: "agent", runtime: "claude-code",
        sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a", lifecycleState: "running",
        tmuxAttachCommand: null, resumeCommand: null, latestError: null,
      }));
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--limit", "2"]);
      });
      const parsed = JSON.parse(logs.join(""));
      expect(parsed.entries).toHaveLength(2);
      expect(parsed.totalNodes).toBe(5);
      expect(parsed.truncated).toBe(true);
      expect(parsed.hint).toContain("--nodes");
      expect(parsed.hint).toContain("--full");
    });
  });
});
