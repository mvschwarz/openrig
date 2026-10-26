// PL-012 Token / Context Usage Surface v0 — `rig ps --nodes --filter
// contextUsage.percent>=N` + `contextUsage.state=…` + `--fields contextUsage`.
// Mirrors the PL-019 mock-daemon harness so this stays independent of
// any other slice in flight.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
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
    try { await fn(); } catch { /* commander throws on exitOverride */ }
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

function nodeAt(logicalId: string, percent: number | null, fresh = true) {
  return {
    rigId: "rig-1",
    rigName: "demo",
    logicalId,
    podId: "p-1",
    canonicalSessionName: `demo-${logicalId}`,
    nodeKind: "agent" as const,
    runtime: "claude-code",
    sessionStatus: "running",
    startupStatus: "ready" as const,
    restoreOutcome: "n-a",
    tmuxAttachCommand: null,
    resumeCommand: null,
    latestError: null,
    contextUsage: {
      availability: percent === null ? "unknown" : "known",
      usedPercentage: percent,
      fresh,
      sampledAt: percent === null ? null : "2026-05-04T12:00:00.000Z",
    },
  };
}

function rigAt(rigId: string, name: string, status: "running" | "stopped", nodeCount: number, runningCount: number) {
  return {
    rigId,
    name,
    rigName: name,
    nodeCount,
    runningCount,
    activeCount: status === "running" ? 1 : 0,
    hasWorkCount: 0,
    attentionCount: 0,
    status,
    lifecycleState: "ready",
    uptime: "1h",
    latestSnapshot: null,
  };
}

const contextFilterCases = [
  { filter: "contextUsage.percent>=80", key: "contextUsage.percent", value: "80" },
  { filter: "contextUsage.state=critical", key: "contextUsage.state", value: "critical" },
] as const;

describe("PL-012 ps --filter contextUsage.* + CTX field", () => {
  let server: http.Server;
  let port: number;
  let nodesByRig: Record<string, unknown[]>;
  let rigs: Array<Record<string, unknown>>;
  let savedSessionName: string | undefined;

  beforeAll(async () => {
    savedSessionName = process.env.OPENRIG_SESSION_NAME;
    delete process.env.OPENRIG_SESSION_NAME;
    server = http.createServer((req, res) => {
      const m = req.url?.match(/^\/api\/rigs\/([^/]+)\/nodes(?:\?.*)?$/);
      if (m && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(nodesByRig[decodeURIComponent(m[1]!)] ?? []));
      } else if (req.url && new URL(req.url, "http://127.0.0.1").pathname === "/api/ps" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rigs));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
  });
  beforeEach(() => {
    nodesByRig = {};
    rigs = [rigAt("rig-1", "demo", "running", 4, 4)];
  });
  afterAll(() => {
    server.close();
    if (savedSessionName !== undefined) process.env.OPENRIG_SESSION_NAME = savedSessionName;
  });

  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(psCommand(runningDeps(port)));
    return prog;
  }

  it("--filter contextUsage.percent>=80 narrows to critical seats", async () => {
    nodesByRig["rig-1"] = [
      nodeAt("alpha", 90),
      nodeAt("beta", 65),
      nodeAt("gamma", 30),
      nodeAt("delta", null),
    ];
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--filter", "contextUsage.percent>=80"]);
    });
    expect(exitCode).toBeUndefined();
    const env = JSON.parse(logs.join(""));
    const entries = Array.isArray(env) ? env : env.entries;
    expect(entries.map((e: { canonicalSessionName: string }) => e.canonicalSessionName)).toEqual(["demo-alpha"]);
  });

  it("--filter contextUsage.percent<60 picks low/ok seats only", async () => {
    nodesByRig["rig-1"] = [nodeAt("alpha", 90), nodeAt("beta", 65), nodeAt("gamma", 30)];
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--filter", "contextUsage.percent<60"]);
    });
    expect(exitCode).toBeUndefined();
    const env = JSON.parse(logs.join(""));
    const entries = Array.isArray(env) ? env : env.entries;
    expect(entries.map((e: { canonicalSessionName: string }) => e.canonicalSessionName)).toEqual(["demo-gamma"]);
  });

  it("--filter contextUsage.percent>=N excludes nodes with no sample (unknown availability)", async () => {
    nodesByRig["rig-1"] = [nodeAt("alpha", 90), nodeAt("delta", null)];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--filter", "contextUsage.percent>=0"]);
    });
    const env = JSON.parse(logs.join(""));
    const entries = Array.isArray(env) ? env : env.entries;
    expect(entries.map((e: { canonicalSessionName: string }) => e.canonicalSessionName)).toEqual(["demo-alpha"]);
  });

  it("--filter contextUsage.state=critical maps tier semantics correctly", async () => {
    nodesByRig["rig-1"] = [
      nodeAt("alpha", 90),  // critical
      nodeAt("beta", 65),   // warning
      nodeAt("gamma", 30),  // low
      nodeAt("delta", null),// unknown
    ];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--filter", "contextUsage.state=critical"]);
    });
    const env = JSON.parse(logs.join(""));
    const entries = Array.isArray(env) ? env : env.entries;
    expect(entries.map((e: { canonicalSessionName: string }) => e.canonicalSessionName)).toEqual(["demo-alpha"]);
  });

  it("--filter contextUsage.state=unknown picks no-sample seats", async () => {
    nodesByRig["rig-1"] = [nodeAt("alpha", 90), nodeAt("delta", null)];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--filter", "contextUsage.state=unknown"]);
    });
    const env = JSON.parse(logs.join(""));
    const entries = Array.isArray(env) ? env : env.entries;
    expect(entries.map((e: { canonicalSessionName: string }) => e.canonicalSessionName)).toEqual(["demo-delta"]);
  });

  it.each(contextFilterCases)("keeps the rig-tier JSON envelope for $filter", async ({ filter, key }) => {
    const result = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--json", "--filter", filter]);
    });
    expect(result.exitCode).toBeUndefined();
    expect(result.logs).toHaveLength(1);
    expect(JSON.parse(result.logs.join(""))).toEqual({
      entries: [expect.objectContaining({ rigId: "rig-1", name: "demo" })],
      totalRigs: 1,
      truncated: false,
    });
    expect(result.errLogs).toHaveLength(1);
    expect(result.errLogs[0]).toContain(key);
    expect(result.errLogs[0]).toContain("was not applied");
    expect(result.errLogs[0]).toContain("--nodes");
  });

  it.each(contextFilterCases)("keeps stopped rigs in the filtered table for $filter", async ({ filter, key }) => {
    rigs = [
      rigAt("rig-1", "demo", "running", 4, 4),
      rigAt("rig-2", "stopped-demo", "stopped", 2, 0),
    ];
    const result = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--filter", filter]);
    });
    const output = result.logs.join("\n");
    expect(result.exitCode).toBeUndefined();
    expect(output).toContain("demo");
    expect(output).toContain("stopped-demo");
    expect(output).toContain("stopped");
    expect(output).not.toContain("not shown: 1 stopped");
    expect(result.errLogs).toHaveLength(1);
    expect(result.errLogs[0]).toContain(key);
    expect(result.errLogs[0]).toContain("was not applied");
    expect(result.errLogs[0]).toContain("--nodes");
  });

  it.each(contextFilterCases)("keeps the filtered empty-result message for $filter", async ({ filter, key, value }) => {
    rigs = [];
    const result = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--filter", filter]);
    });
    expect(result.exitCode).toBeUndefined();
    expect(result.logs).toEqual([`No rigs match --filter ${key}=${value}`]);
    expect(result.errLogs).toHaveLength(1);
    expect(result.errLogs[0]).toContain(key);
    expect(result.errLogs[0]).toContain("was not applied");
    expect(result.errLogs[0]).toContain("--nodes");
  });

  it("--filter contextUsage.percent>=invalid fails fast with three-part error and exit 1", async () => {
    nodesByRig["rig-1"] = [nodeAt("alpha", 90)];
    const { errLogs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--filter", "contextUsage.percent>=banana"]);
    });
    expect(exitCode).toBe(1);
    const out = errLogs.join("\n");
    expect(out).toContain("contextUsage.percent>='banana'");
    expect(out).toContain("a finite number");
    expect(out).toContain("rig ps --nodes --fields contextUsage --json");
  });

  it("--filter contextUsage.state=bogus fails fast with three-part error and exit 1", async () => {
    nodesByRig["rig-1"] = [nodeAt("alpha", 90)];
    const { errLogs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--filter", "contextUsage.state=lol-no"]);
    });
    expect(exitCode).toBe(1);
    const out = errLogs.join("\n");
    expect(out).toContain("contextUsage.state='lol-no'");
    expect(out).toContain("critical, low, unknown, warning");
    expect(out).toContain("rig ps --nodes --fields contextUsage --json");
  });

  it("--filter contextUsage.percent>=N rejects equality-only on non-numeric keys cleanly", async () => {
    nodesByRig["rig-1"] = [nodeAt("alpha", 90)];
    const { errLogs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--filter", "name>=demo"]);
    });
    expect(exitCode).toBe(1);
    expect(errLogs.join("\n")).toContain("numeric comparator on a non-numeric key");
  });

  it("--fields contextUsage projects only the contextUsage column", async () => {
    nodesByRig["rig-1"] = [nodeAt("alpha", 73)];
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--fields", "logicalId,contextUsage"]);
    });
    expect(exitCode).toBeUndefined();
    const env = JSON.parse(logs.join(""));
    const entries = Array.isArray(env) ? env : env.entries;
    expect(entries[0]).toEqual({ logicalId: "alpha", contextUsage: expect.objectContaining({ usedPercentage: 73 }) });
  });

  it("CTX column appears in --full human output", async () => {
    nodesByRig["rig-1"] = [nodeAt("alpha", 73), nodeAt("delta", null)];
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--full"]);
    });
    expect(exitCode).toBeUndefined();
    const out = logs.join("\n");
    expect(out).toContain("CTX");
    expect(out).toContain("73%");
    expect(out).toContain("??"); // unknown placeholder
  });
});
