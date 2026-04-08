import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { DaemonClient } from "../src/client.js";
import { adoptCommand } from "../src/commands/adopt.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { ImportDeps } from "../src/commands/import.js";

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
  return { pid: 123, port, db: "test.sqlite", startedAt: "2026-04-02T00:00:00Z" };
}

function runningDeps(port: number, fileContent: string | Record<string, string>): ImportDeps {
  return {
    lifecycleDeps: mockLifecycleDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify(runningState(port));
        return null;
      }),
      fetch: vi.fn(async () => ({ ok: true })),
    }),
    clientFactory: (baseUrl: string) => new DaemonClient(baseUrl),
    readFile: vi.fn((p: string) => {
      if (typeof fileContent === "string") return fileContent;
      const value = fileContent[p];
      if (value == null) throw new Error(`missing file: ${p}`);
      return value;
    }),
  };
}

describe("rig adopt", () => {
  let server: http.Server;
  let port: number;
  let capturedMaterializeHeaders: Record<string, string | string[] | undefined> = {};
  const bindRequests: Array<{ path: string; body: Record<string, unknown> }> = [];

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;

      if (req.method === "POST" && req.url === "/api/rigs/import/materialize") {
        capturedMaterializeHeaders = {
          "x-rig-root": req.headers["x-rig-root"],
          "x-target-rig-id": req.headers["x-target-rig-id"],
        };
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          rigId: req.headers["x-target-rig-id"] ?? "rig-new",
          specName: "captured-dev-pod",
          specVersion: "0.2",
          nodes: [
            { logicalId: "research.scout", status: "materialized" },
            { logicalId: "research.mapper", status: "materialized" },
          ],
        }));
        return;
      }

      if (req.method === "POST" && req.url === "/api/discovery/scan") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sessions: [] }));
        return;
      }

      if (req.method === "GET" && req.url === "/api/discovery?status=active") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([
          { id: "ds-scout", tmuxSession: "proof-research-scout2", status: "active", runtimeHint: "codex", confidence: "high" },
          { id: "ds-mapper", tmuxSession: "proof-research-mapper2", status: "active", runtimeHint: "codex", confidence: "high" },
        ]));
        return;
      }

      if (req.method === "POST" && req.url?.match(/^\/api\/discovery\/[^/]+\/bind$/)) {
        bindRequests.push({
          path: req.url,
          body: body ? JSON.parse(body) as Record<string, unknown> : {},
        });
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, nodeId: "node-1", sessionId: "sess-1" }));
        return;
      }

      if (req.url === "/healthz") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  it("materializes then binds mapped tmux sessions", async () => {
    bindRequests.length = 0;
    const program = new Command();
    program.exitOverride();
    program.addCommand(adoptCommand(runningDeps(port, `version: "0.2"\nname: captured-dev-pod\npods: []\n`)));

    const { logs, exitCode } = await captureLogs(async () => {
      await program.parseAsync([
        "node", "rig", "adopt", "rig.yaml",
        "--target-rig", "rig-123",
        "--rig-root", "/tmp/captured-dev-pod",
        "--bind", "research.scout=proof-research-scout2",
        "--bind", "research.mapper=proof-research-mapper2",
      ]);
    });

    expect(exitCode).toBeUndefined();
    expect(capturedMaterializeHeaders["x-target-rig-id"]).toBe("rig-123");
    expect(capturedMaterializeHeaders["x-rig-root"]).toBe("/tmp/captured-dev-pod");
    expect(bindRequests).toHaveLength(2);
    expect(bindRequests[0]!.body).toEqual({ rigId: "rig-123", logicalId: "research.scout" });
    expect(bindRequests[1]!.body).toEqual({ rigId: "rig-123", logicalId: "research.mapper" });
    const output = logs.join("\n");
    expect(output).toContain("captured-dev-pod");
    expect(output).toContain("research.scout");
    expect(output).toContain("proof-research-scout2");
  });

  it("returns exit 1 when a mapped tmux session cannot be found", async () => {
    bindRequests.length = 0;
    const program = new Command();
    program.exitOverride();
    program.addCommand(adoptCommand(runningDeps(port, `version: "0.2"\nname: captured-dev-pod\npods: []\n`)));

    const { logs, exitCode } = await captureLogs(async () => {
      await program.parseAsync([
        "node", "rig", "adopt", "rig.yaml",
        "--rig-root", "/tmp/captured-dev-pod",
        "--bind", "research.scout=proof-research-scout2",
        "--bind", "research.synth=missing-session",
      ]);
    });

    expect(exitCode).toBe(1);
    expect(bindRequests).toHaveLength(1);
    expect(logs.join("\n")).toContain("missing-session");
    expect(logs.join("\n")).toContain("not found in active discovery");
  });

  it("supports machine-readable json output", async () => {
    bindRequests.length = 0;
    const program = new Command();
    program.exitOverride();
    program.addCommand(adoptCommand(runningDeps(port, `version: "0.2"\nname: captured-dev-pod\npods: []\n`)));

    const { logs, exitCode } = await captureLogs(async () => {
      await program.parseAsync([
        "node", "rig", "adopt", "rig.yaml",
        "--rig-root", "/tmp/captured-dev-pod",
        "--bind", "research.scout=proof-research-scout2",
        "--json",
      ]);
    });

    expect(exitCode).toBeUndefined();
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.rigId).toBe("rig-new");
    expect(parsed.bindings).toHaveLength(1);
    expect(parsed.bindings[0]).toMatchObject({
      logicalId: "research.scout",
      sessionName: "proof-research-scout2",
      ok: true,
    });
  });

  it("loads bindings from a bindings file", async () => {
    bindRequests.length = 0;
    const program = new Command();
    program.exitOverride();
    program.addCommand(adoptCommand(runningDeps(port, {
      "rig.yaml": `version: "0.2"\nname: captured-dev-pod\npods: []\n`,
      "bindings.yaml": `bindings:\n  research.scout: proof-research-scout2\n  research.mapper: ds-mapper\n`,
    })));

    const { exitCode } = await captureLogs(async () => {
      await program.parseAsync([
        "node", "rig", "adopt", "rig.yaml",
        "--bindings-file", "bindings.yaml",
      ]);
    });

    expect(exitCode).toBeUndefined();
    expect(bindRequests).toHaveLength(2);
    expect(bindRequests[0]!.body).toEqual({ rigId: "rig-new", logicalId: "research.scout" });
    expect(bindRequests[1]!.body).toEqual({ rigId: "rig-new", logicalId: "research.mapper" });
  });

  it("fails when both --bind and --bindings-file are supplied", async () => {
    bindRequests.length = 0;
    const program = new Command();
    program.exitOverride();
    program.addCommand(adoptCommand(runningDeps(port, {
      "rig.yaml": `version: "0.2"\nname: captured-dev-pod\npods: []\n`,
      "bindings.yaml": `bindings:\n  research.scout: proof-research-scout2\n`,
    })));

    const { logs, exitCode } = await captureLogs(async () => {
      await program.parseAsync([
        "node", "rig", "adopt", "rig.yaml",
        "--bind", "research.mapper=proof-research-mapper2",
        "--bindings-file", "bindings.yaml",
      ]);
    });

    expect(exitCode).toBe(1);
    expect(bindRequests).toHaveLength(0);
    expect(logs.join("\n")).toContain("Use either --bind or --bindings-file");
  });
});
