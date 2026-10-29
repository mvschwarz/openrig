import { allowOwnedHttpFixture } from "./helpers/owned-http-fixture.js";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { discoverCommand } from "../src/commands/discover.js";
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

async function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  const logs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.error = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    await fn();
    const exitCode = process.exitCode;
    return { logs, exitCode };
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exitCode = origExitCode;
  }
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
      } else if (req.url === "/api/discovery/draft-rig" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "text/yaml" });
        res.end("# WARNING: Excluded session 'unknown': runtime could not be determined.\nname: draft-rig\n");
      } else if (req.url?.match(/\/api\/discovery\/ds-1\/bind/) && req.method === "POST") {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, nodeId: "node-1", sessionId: "sess-1" }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    allowOwnedHttpFixture(server);
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

  it("discover --draft prints raw YAML response", async () => {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(discoverCommand(runningDeps(port)));

    const { logs, exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "discover", "--draft"]);
    });

    const output = logs.join("\n");
    expect(exitCode).toBeUndefined();
    expect(output).toContain("# WARNING: Excluded session 'unknown'");
    expect(output).toContain("name: draft-rig");
  });

  // T10: claim success
  // claim test removed — claim command deleted in bind consolidation

  // T12: discover with 500 response -> exit 1 with error
  it("discover with scan failure returns exit 1 with error", async () => {
    const failServer = http.createServer((_, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "tmux boom" }));
    });
    await new Promise<void>((resolve) => { failServer.listen(0, resolve); });
    allowOwnedHttpFixture(failServer);
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

  // claim nonexistent test removed — claim command deleted

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
