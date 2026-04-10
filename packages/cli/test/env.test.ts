import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { envCommand } from "../src/commands/env.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(): LifecycleDeps {
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

describe("rig env", () => {
  let server: http.Server;
  let port: number;

  const rigSummary = [{ id: "rig-1", name: "my-rig", nodeCount: 2 }];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = req.url ?? "";
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk; });
      req.on("end", () => {
        if (url === "/api/rigs/summary") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(rigSummary));
          return;
        }

        if (url.includes("/env/logs")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, output: "vault | 2026-04-09 12:00:00 Starting vault server..." }));
          return;
        }

        if (url.includes("/env/down") && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (url.includes("/env")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: true,
            hasServices: true,
            kind: "compose",
            projectName: "my-rig",
            receipt: {
              kind: "compose",
              services: [{ name: "vault", status: "running", health: "healthy" }],
              waitFor: [],
              capturedAt: "2026-04-09T00:00:00Z",
            },
          }));
          return;
        }

        res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  function runningDeps(): StatusDeps {
    return {
      lifecycleDeps: {
        ...mockLifecycleDeps(),
        exists: vi.fn((p: string) => p === STATE_FILE),
        readFile: vi.fn((p: string) => {
          if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-09T00:00:00Z" } as DaemonState);
          return null;
        }),
        fetch: vi.fn(async () => ({ ok: true })),
      },
      clientFactory: (baseUrl) => new DaemonClient(baseUrl),
    };
  }

  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(envCommand(runningDeps()));
    return prog;
  }

  it("env help explains managed-app usage", () => {
    const logs: string[] = [];
    const cmd = makeCmd().commands.find((c) => c.name() === "env")!;
    cmd.configureOutput({ writeOut: (str) => logs.push(str), writeErr: (str) => logs.push(str) });
    cmd.outputHelp();
    const help = logs.join("");
    expect(help).toContain("Inspect and control rig environment services");
    expect(help).toContain("service-backed rigs and managed");
    expect(help).toContain("rig env status secrets-manager");
    expect(help).toContain("rig env logs secrets-manager vault");
  });

  it("env status prints service status", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "env", "status", "my-rig"]);
    });

    const output = logs.join("\n");
    expect(output).toContain("vault");
    expect(output).toContain("running");
  });

  it("env status --json returns machine-readable output", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "env", "status", "my-rig", "--json"]);
    });

    const parsed = JSON.parse(logs.join(""));
    expect(parsed.hasServices).toBe(true);
    expect(parsed.receipt.services).toHaveLength(1);
  });

  it("env logs returns service logs", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "env", "logs", "my-rig"]);
    });

    expect(logs.join("\n")).toContain("Starting vault server");
  });

  it("env down stops services", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "env", "down", "my-rig"]);
    });

    expect(logs.join("\n")).toContain("Services stopped");
  });

  it("env is wired via createProgram", async () => {
    const { createProgram } = await import("../src/index.js");
    const program = createProgram();
    const envCmd = program.commands.find((c) => c.name() === "env");
    expect(envCmd).toBeDefined();
  });
});
