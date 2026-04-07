import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { discoverCommand } from "../src/commands/discover.js";
import { claimCommand } from "../src/commands/claim.js";
import { bindCommand } from "../src/commands/bind.js";
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
  return { pid: 123, port, db: "test.sqlite", startedAt: "2026-03-26T00:00:00Z" };
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

describe("Discover + Claim CLI", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;

      if (req.url === "/api/discovery/scan" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          sessions: [
            { id: "ds-1", tmuxSession: "organic", tmuxPane: "%0", runtimeHint: "claude-code", confidence: "high", cwd: "/projects" },
          ],
        }));
      } else if (req.url?.match(/\/api\/discovery\/ds-1\/bind/) && req.method === "POST") {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, nodeId: "node-1", sessionId: "sess-1" }));
      } else if (req.url?.match(/\/api\/discovery\/ds-1\/claim/) && req.method === "POST") {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, nodeId: "node-1", sessionId: "sess-1" }));
      } else if (req.url?.match(/\/api\/discovery\/nonexistent\/claim/) && req.method === "POST") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, code: "not_found", error: "Discovery record not found" }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  // T8: discover prints table
  it("discover prints discovered sessions table", async () => {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(discoverCommand(runningDeps(port)));

    const { logs } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "discover"]);
    });

    expect(logs.some((l) => l.includes("DISCOVERED SESSIONS"))).toBe(true);
    expect(logs.some((l) => l.includes("organic"))).toBe(true);
    expect(logs.some((l) => l.includes("claude-code"))).toBe(true);
  });

  // T9: discover --json
  it("discover --json outputs parseable JSON", async () => {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(discoverCommand(runningDeps(port)));

    const { logs } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "discover", "--json"]);
    });

    const parsed = JSON.parse(logs.join(""));
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].id).toBe("ds-1");
  });

  // T10: claim success
  it("claim creates node and prints confirmation", async () => {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(claimCommand(runningDeps(port)));

    const { logs } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "claim", "ds-1", "--rig", "rig-1"]);
    });

    expect(logs.some((l) => l.includes("Claimed as node"))).toBe(true);
    expect(logs.some((l) => l.includes("node-1"))).toBe(true);
  });

  // T12: discover with 500 response -> exit 1 with error
  it("discover with scan failure returns exit 1 with error", async () => {
    const failServer = http.createServer((_, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "tmux boom" }));
    });
    await new Promise<void>((resolve) => { failServer.listen(0, resolve); });
    const failPort = (failServer.address() as { port: number }).port;

    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(discoverCommand(runningDeps(failPort)));

    const { logs, exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "discover"]);
    });

    expect(exitCode).toBe(1);
    expect(logs.some((l) => l.includes("tmux boom"))).toBe(true);
    expect(logs.some((l) => l.includes("No unmanaged sessions"))).toBe(false);
    failServer.close();
  });

  // T13: claim nonexistent -> exit 1
  it("claim nonexistent discovery returns exit 1", async () => {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(claimCommand(runningDeps(port)));

    const { exitCode, logs } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "claim", "nonexistent", "--rig", "rig-1"]);
    });

    expect(exitCode).toBe(1);
    expect(logs.some((l) => l.includes("not found"))).toBe(true);
  });

  it("bind attaches discovered session to an existing node", async () => {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(bindCommand(runningDeps(port)));

    const { logs } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "bind", "ds-1", "--rig", "rig-1", "--node", "orch.lead"]);
    });

    expect(logs.some((l) => l.includes("Bound discovery"))).toBe(true);
    expect(logs.some((l) => l.includes("orch.lead"))).toBe(true);
  });
});
