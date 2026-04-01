import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { upCommand } from "../src/commands/up.js";
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

describe("Up CLI", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;

      if (req.url === "/api/up" && req.method === "POST") {
        const parsed = JSON.parse(body);
        if (parsed.plan) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "planned", runId: "run-1", stages: [{ stage: "resolve_spec", status: "ok" }], errors: [], warnings: [] }));
        } else {
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "completed", runId: "run-2", rigId: "rig-1", stages: [{ stage: "resolve_spec", status: "ok" }, { stage: "import_rig", status: "ok" }], errors: [], warnings: [], attachCommand: "tmux attach -t dev-impl@test-rig" }));
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
    prog.addCommand(upCommand(runningDeps(port)));
    return prog;
  }

  // T7: up from .yaml -> stages + rig ID
  it("up prints stages and rig ID", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "up", "/tmp/rig.yaml"]);
    });
    expect(logs.some((l) => l.includes("resolve_spec"))).toBe(true);
    expect(logs.some((l) => l.includes("rig-1"))).toBe(true);
    expect(logs.some((l) => l.includes("completed"))).toBe(true);
  });

  // T8: up --plan
  it("up --plan prints planned status", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "up", "/tmp/rig.yaml", "--plan"]);
    });
    expect(logs.some((l) => l.includes("planned"))).toBe(true);
  });

  // T9: --yes sends autoApprove
  it("up --yes sends autoApprove=true", async () => {
    let lastBody: Record<string, unknown> = {};
    const origListeners = server.listeners("request");
    server.removeAllListeners("request");
    server.on("request", async (req: http.IncomingMessage, res: http.ServerResponse) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (req.url === "/api/up") {
        lastBody = JSON.parse(body);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "completed", runId: "r", rigId: "g", stages: [], errors: [] }));
      }
    });

    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "up", "/tmp/rig.yaml", "--yes"]);
    });

    expect(lastBody.autoApprove).toBe(true);

    server.removeAllListeners("request");
    for (const l of origListeners) server.on("request", l as (...args: unknown[]) => void);
  });

  // T10: --json
  it("up --json outputs parseable JSON", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "up", "/tmp/rig.yaml", "--json"]);
    });
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.status).toBe("completed");
  });

  // T12: Failure -> exit 2
  it("failure response returns exit 2", async () => {
    const failServer = http.createServer((_, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "failed", error: "boom", stages: [], errors: ["boom"] }));
    });
    await new Promise<void>((resolve) => { failServer.listen(0, resolve); });
    const failPort = (failServer.address() as { port: number }).port;

    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(upCommand(runningDeps(failPort)));

    const { exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rigged", "up", "/tmp/rig.yaml"]);
    });

    expect(exitCode).toBe(2);
    failServer.close();
  });

  // T13: Relative path resolved to absolute before sending
  it("resolves relative path to absolute in POST body", async () => {
    let lastBody: Record<string, unknown> = {};
    const origListeners = server.listeners("request");
    server.removeAllListeners("request");
    server.on("request", async (req: http.IncomingMessage, res: http.ServerResponse) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (req.url === "/api/up") {
        lastBody = JSON.parse(body);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "completed", runId: "r", rigId: "g", stages: [], errors: [] }));
      }
    });

    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "up", "relative/spec.yaml"]);
    });

    // sourceRef must be an absolute path, not the raw relative input
    expect(lastBody.sourceRef).toMatch(/^\//);
    expect((lastBody.sourceRef as string).endsWith("relative/spec.yaml")).toBe(true);

    server.removeAllListeners("request");
    for (const l of origListeners) server.on("request", l as (...args: unknown[]) => void);
  });

  // NS-T14: fresh boot handoff includes dashboard URL + attach command
  it("fresh boot success shows dashboard URL and attach command", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "up", "/tmp/test.yaml"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("Dashboard: rigged ui open");
    expect(output).toContain("Attach:");
    expect(output).toContain("tmux attach -t dev-impl@test-rig");
  });

  // PNS-T06: fresh boot warnings (e.g. transcript attach failures) surface to stderr
  it("fresh boot success prints warnings when present", async () => {
    const origListeners = server.listeners("request");
    server.removeAllListeners("request");
    server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk; });
      req.on("end", () => {
        if (req.url === "/api/up" && req.method === "POST") {
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            status: "completed", runId: "run-3", rigId: "rig-2",
            stages: [{ stage: "import_rig", status: "ok" }],
            errors: [],
            warnings: ["Transcript capture failed for dev-impl@test-rig: pipe-pane failed"],
          }));
        } else {
          res.writeHead(404).end();
        }
      });
    });

    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "up", "/tmp/test.yaml"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("warning: Transcript capture failed");

    server.removeAllListeners("request");
    for (const l of origListeners) server.on("request", l as (...args: unknown[]) => void);
  });
});
