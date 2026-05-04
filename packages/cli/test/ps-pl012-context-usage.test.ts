// PL-012 Token / Context Usage Surface v0 — `rig ps --nodes --filter
// contextUsage.percent>=N` + `contextUsage.state=…` + `--fields contextUsage`.
// Mirrors the PL-019 mock-daemon harness so this stays independent of
// any other slice in flight.

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

describe("PL-012 ps --filter contextUsage.* + CTX field", () => {
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

  it("--filter contextUsage.percent>=80 narrows to critical seats", async () => {
    nodesByRig["rig-1"] = [
      nodeAt("alpha", 90),
      nodeAt("beta", 65),
      nodeAt("gamma", 30),
      nodeAt("delta", null),
    ];
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--filter", "contextUsage.percent>=80"]);
    });
    expect(exitCode).toBeUndefined();
    const env = JSON.parse(logs.join(""));
    const entries = Array.isArray(env) ? env : env.entries;
    expect(entries.map((e: { logicalId: string }) => e.logicalId)).toEqual(["alpha"]);
  });

  it("--filter contextUsage.percent<60 picks low/ok seats only", async () => {
    nodesByRig["rig-1"] = [nodeAt("alpha", 90), nodeAt("beta", 65), nodeAt("gamma", 30)];
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--filter", "contextUsage.percent<60"]);
    });
    expect(exitCode).toBeUndefined();
    const env = JSON.parse(logs.join(""));
    const entries = Array.isArray(env) ? env : env.entries;
    expect(entries.map((e: { logicalId: string }) => e.logicalId)).toEqual(["gamma"]);
  });

  it("--filter contextUsage.percent>=N excludes nodes with no sample (unknown availability)", async () => {
    nodesByRig["rig-1"] = [nodeAt("alpha", 90), nodeAt("delta", null)];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--filter", "contextUsage.percent>=0"]);
    });
    const env = JSON.parse(logs.join(""));
    const entries = Array.isArray(env) ? env : env.entries;
    expect(entries.map((e: { logicalId: string }) => e.logicalId)).toEqual(["alpha"]);
  });

  it("--filter contextUsage.state=critical maps tier semantics correctly", async () => {
    nodesByRig["rig-1"] = [
      nodeAt("alpha", 90),  // critical
      nodeAt("beta", 65),   // warning
      nodeAt("gamma", 30),  // low
      nodeAt("delta", null),// unknown
    ];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--filter", "contextUsage.state=critical"]);
    });
    const env = JSON.parse(logs.join(""));
    const entries = Array.isArray(env) ? env : env.entries;
    expect(entries.map((e: { logicalId: string }) => e.logicalId)).toEqual(["alpha"]);
  });

  it("--filter contextUsage.state=unknown picks no-sample seats", async () => {
    nodesByRig["rig-1"] = [nodeAt("alpha", 90), nodeAt("delta", null)];
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--filter", "contextUsage.state=unknown"]);
    });
    const env = JSON.parse(logs.join(""));
    const entries = Array.isArray(env) ? env : env.entries;
    expect(entries.map((e: { logicalId: string }) => e.logicalId)).toEqual(["delta"]);
  });

  it("--filter contextUsage.percent>=invalid fails fast with three-part error and exit 1", async () => {
    nodesByRig["rig-1"] = [nodeAt("alpha", 90)];
    const { errLogs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--filter", "contextUsage.percent>=banana"]);
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
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--filter", "contextUsage.state=lol-no"]);
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
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--filter", "name>=demo"]);
    });
    expect(exitCode).toBe(1);
    expect(errLogs.join("\n")).toContain("numeric comparator on a non-numeric key");
  });

  it("--fields contextUsage projects only the contextUsage column", async () => {
    nodesByRig["rig-1"] = [nodeAt("alpha", 73)];
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--fields", "logicalId,contextUsage"]);
    });
    expect(exitCode).toBeUndefined();
    const env = JSON.parse(logs.join(""));
    const entries = Array.isArray(env) ? env : env.entries;
    expect(entries[0]).toEqual({ logicalId: "alpha", contextUsage: expect.objectContaining({ usedPercentage: 73 }) });
  });

  it("CTX column appears in human output", async () => {
    nodesByRig["rig-1"] = [nodeAt("alpha", 73), nodeAt("delta", null)];
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes"]);
    });
    expect(exitCode).toBeUndefined();
    const out = logs.join("\n");
    expect(out).toContain("CTX");
    expect(out).toContain("73%");
    expect(out).toContain("??"); // unknown placeholder
  });
});
