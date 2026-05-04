// PL-019 item 1: --filter agentActivity.state=<state> + --active sugar.
// Focused tests; the existing ps.test.ts covers the broader filter
// machinery surface. We mirror its mock-daemon harness so this stays
// independent of any other slice in flight.

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

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; errLogs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const errLogs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExitCode = process.exitCode;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { errLogs.push(args.map(String).join(" ")); };
    process.exitCode = undefined;
    try { await fn(); } catch { /* commander throws on exitOverride; logged separately */ }
    const exitCode = process.exitCode;
    console.log = origLog;
    console.error = origErr;
    process.exitCode = origExitCode;
    resolve({ logs, errLogs, exitCode });
  });
}

function runningDeps(port: number): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-05-04T00:00:00Z" } as DaemonState);
        return null;
      }),
      fetch: vi.fn(async () => ({ ok: true })),
    }),
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
}

const NODE_RUNNING = {
  rigId: "rig-1",
  rigName: "demo",
  logicalId: "alpha",
  podId: "p-1",
  canonicalSessionName: "demo-alpha",
  nodeKind: "agent" as const,
  runtime: "claude-code",
  sessionStatus: "running",
  startupStatus: "ready" as const,
  restoreOutcome: "n-a",
  tmuxAttachCommand: null,
  resumeCommand: null,
  latestError: null,
  agentActivity: {
    state: "running" as const,
    reason: "mid_work_pattern",
    evidenceSource: "pane_heuristic",
    sampledAt: "2026-05-04T12:00:00.000Z",
    evidence: "Working on x",
  },
};

const NODE_IDLE = {
  rigId: "rig-1",
  rigName: "demo",
  logicalId: "beta",
  podId: "p-1",
  canonicalSessionName: "demo-beta",
  nodeKind: "agent" as const,
  runtime: "claude-code",
  sessionStatus: "running",
  startupStatus: "ready" as const,
  restoreOutcome: "n-a",
  tmuxAttachCommand: null,
  resumeCommand: null,
  latestError: null,
  agentActivity: {
    state: "idle" as const,
    reason: "idle_prompt",
    evidenceSource: "pane_heuristic",
    sampledAt: "2026-05-04T12:00:00.000Z",
    evidence: "$ ",
  },
};

const NODE_NEEDS_INPUT = {
  rigId: "rig-1",
  rigName: "demo",
  logicalId: "gamma",
  podId: "p-1",
  canonicalSessionName: "demo-gamma",
  nodeKind: "agent" as const,
  runtime: "claude-code",
  sessionStatus: "running",
  startupStatus: "ready" as const,
  restoreOutcome: "n-a",
  tmuxAttachCommand: null,
  resumeCommand: null,
  latestError: null,
  agentActivity: {
    state: "needs_input" as const,
    reason: "approval_pending",
    evidenceSource: "pane_heuristic",
    sampledAt: "2026-05-04T12:00:00.000Z",
    evidence: "Approve?",
  },
};

const NODE_UNKNOWN = {
  rigId: "rig-1",
  rigName: "demo",
  logicalId: "delta",
  podId: "p-1",
  canonicalSessionName: "demo-delta",
  nodeKind: "agent" as const,
  runtime: "claude-code",
  sessionStatus: "running",
  startupStatus: "ready" as const,
  restoreOutcome: "n-a",
  tmuxAttachCommand: null,
  resumeCommand: null,
  latestError: null,
  agentActivity: {
    state: "unknown" as const,
    reason: "capture_failed",
    evidenceSource: "pane_heuristic",
    sampledAt: "2026-05-04T12:00:00.000Z",
    evidence: null,
  },
};

describe("PL-019 ps --filter agentActivity.state + --active", () => {
  let server: http.Server;
  let port: number;
  let nodesByRig: Record<string, unknown[]>;

  beforeAll(async () => {
    nodesByRig = {};
    server = http.createServer((req, res) => {
      const m = req.url?.match(/^\/api\/rigs\/([^/]+)\/nodes(?:\?.*)?$/);
      if (m && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(nodesByRig[decodeURIComponent(m[1]!)] ?? []));
      } else if (req.url === "/api/ps" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([{ rigId: "rig-1", name: "demo", nodeCount: 4, runningCount: 4, status: "running", uptime: "1h", latestSnapshot: null }]));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => server.close());

  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(psCommand(runningDeps(port)));
    return prog;
  }

  it("--filter agentActivity.state=running narrows to the running node", async () => {
    nodesByRig["rig-1"] = [NODE_RUNNING, NODE_IDLE, NODE_NEEDS_INPUT, NODE_UNKNOWN];
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--filter", "agentActivity.state=running"]);
    });
    expect(exitCode).toBeUndefined();
    const env = JSON.parse(logs.join(""));
    const entries = Array.isArray(env) ? env : env.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].logicalId).toBe("alpha");
    expect(entries[0].agentActivity.state).toBe("running");
  });

  it("--active is identical to --filter agentActivity.state=running on same fixture", async () => {
    nodesByRig["rig-1"] = [NODE_RUNNING, NODE_IDLE, NODE_NEEDS_INPUT, NODE_UNKNOWN];
    const a = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--filter", "agentActivity.state=running"]);
    });
    const b = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--active"]);
    });
    expect(a.exitCode).toBeUndefined();
    expect(b.exitCode).toBeUndefined();
    expect(a.logs.join("")).toBe(b.logs.join(""));
  });

  it("--filter agentActivity.state=needs_input picks the amber-state node", async () => {
    nodesByRig["rig-1"] = [NODE_RUNNING, NODE_IDLE, NODE_NEEDS_INPUT, NODE_UNKNOWN];
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--filter", "agentActivity.state=needs_input"]);
    });
    expect(exitCode).toBeUndefined();
    const env = JSON.parse(logs.join(""));
    const entries = Array.isArray(env) ? env : env.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].logicalId).toBe("gamma");
  });

  it("--filter agentActivity.state=invalid fails fast with three-part error and exit 1", async () => {
    nodesByRig["rig-1"] = [NODE_RUNNING];
    const { errLogs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--filter", "agentActivity.state=lol-no"]);
    });
    expect(exitCode).toBe(1);
    const errOutput = errLogs.join("\n");
    // What failed
    expect(errOutput).toContain("agentActivity.state='lol-no'");
    // What's allowed (sorted enum)
    expect(errOutput).toContain("idle, needs_input, running, unknown");
    // What to do (next-step pointer)
    expect(errOutput).toContain("rig ps --nodes --fields agentActivity --json");
  });

  it("--active combined with --filter is rejected explicitly with exit 1", async () => {
    nodesByRig["rig-1"] = [NODE_RUNNING];
    const { errLogs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--active", "--filter", "status=running"]);
    });
    expect(exitCode).toBe(1);
    expect(errLogs.join("\n")).toContain("--active and --filter cannot be combined");
  });

  it("--filter agentActivity.state=running excludes nodes whose agentActivity is missing", async () => {
    const NODE_NO_ACTIVITY = {
      ...NODE_RUNNING,
      logicalId: "epsilon",
      canonicalSessionName: "demo-epsilon",
      agentActivity: undefined,
    };
    nodesByRig["rig-1"] = [NODE_RUNNING, NODE_NO_ACTIVITY];
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--active"]);
    });
    expect(exitCode).toBeUndefined();
    const env = JSON.parse(logs.join(""));
    const entries = Array.isArray(env) ? env : env.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].logicalId).toBe("alpha");
  });
});
