import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { bootstrapCommand } from "../src/commands/bootstrap.js";
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

describe("Bootstrap CLI", () => {
  let server: http.Server;
  let port: number;
  let lastReq: { url: string; method: string; body: string };

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      lastReq = { url: req.url ?? "", method: req.method ?? "", body };

      if (req.url === "/api/bootstrap/plan" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          runId: "run-1", status: "planned",
          stages: [{ stage: "resolve_spec", status: "ok" }, { stage: "verify_runtimes", status: "ok" }],
          actionKeys: ["external_install:cli_tool:rg"], errors: [], warnings: [],
        }));
      } else if (req.url === "/api/bootstrap/apply" && req.method === "POST") {
        const parsed = JSON.parse(body);
        if (parsed.autoApprove) {
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            runId: "run-2", status: "completed", rigId: "rig-1",
            stages: [{ stage: "resolve_spec", status: "ok" }, { stage: "import_rig", status: "ok" }],
            errors: [], warnings: [],
          }));
        } else {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            runId: "run-3", status: "failed",
            stages: [{ stage: "execute_external_installs", status: "blocked" }],
            errors: ["External installs require approval"], warnings: [],
          }));
        }
      } else {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "failed", errors: ["server error"] }));
      }
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(bootstrapCommand(runningDeps(port)));
    return prog;
  }

  // T1: bootstrap --plan prints plan stages
  it("bootstrap --plan prints plan stages", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "bootstrap", "/tmp/rig.yaml", "--plan"]);
    });
    expect(logs.some((l) => l.includes("BOOTSTRAP PLAN"))).toBe(true);
    expect(logs.some((l) => l.includes("resolve_spec"))).toBe(true);
  });

  // T2: bootstrap apply prints result
  it("bootstrap apply prints result with rigId", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "bootstrap", "/tmp/rig.yaml", "--yes"]);
    });
    expect(logs.some((l) => l.includes("Rig: rig-1"))).toBe(true);
    expect(logs.some((l) => l.includes("completed"))).toBe(true);
  });

  // T3: bootstrap --yes sends autoApprove=true
  it("bootstrap --yes sends autoApprove=true in body", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "bootstrap", "/tmp/rig.yaml", "--yes"]);
    });
    const body = JSON.parse(lastReq.body);
    expect(body.autoApprove).toBe(true);
  });

  // T4: bootstrap blocked -> exit 1
  it("bootstrap blocked returns exit code 1", async () => {
    const { exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "bootstrap", "/tmp/rig.yaml"]);
    });
    expect(exitCode).toBe(1);
  });

  // T5: --json outputs parseable JSON
  it("--json outputs parseable JSON", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "bootstrap", "/tmp/rig.yaml", "--plan", "--json"]);
    });
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.status).toBe("planned");
    expect(parsed.runId).toBe("run-1");
  });

  // T6: exit 2 for failure (500)
  it("exit code 2 for server failure", async () => {
    // Create a server that always returns 500 for apply
    const failServer = http.createServer((_, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "failed", stages: [], errors: ["internal error"], warnings: [] }));
    });
    await new Promise<void>((resolve) => { failServer.listen(0, resolve); });
    const failPort = (failServer.address() as { port: number }).port;

    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(bootstrapCommand(runningDeps(failPort)));

    const { exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rigged", "bootstrap", "/tmp/rig.yaml", "--yes"]);
    });

    expect(exitCode).toBe(2);
    failServer.close();
  });

  // T7: daemon not running -> error + exit 1
  it("daemon not running returns exit code 1", async () => {
    const stoppedDeps: StatusDeps = {
      lifecycleDeps: mockLifecycleDeps(),
      clientFactory: (baseUrl) => new DaemonClient(baseUrl),
    };
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(bootstrapCommand(stoppedDeps));

    const { logs, exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rigged", "bootstrap", "/tmp/rig.yaml", "--plan"]);
    });
    expect(exitCode).toBe(1);
    expect(logs.some((l) => l.includes("Daemon not running"))).toBe(true);
  });

  // T8: no flags sends autoApprove=false
  it("bootstrap without --yes sends autoApprove=false", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "bootstrap", "/tmp/rig.yaml"]);
    });
    const body = JSON.parse(lastReq.body);
    expect(body.autoApprove).toBe(false);
  });

  // T9: partial status -> exit 1 (R2-M1)
  it("partial result returns exit code 1", async () => {
    const partialServer = http.createServer((_, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        runId: "run-p", status: "partial", rigId: "rig-p",
        stages: [{ stage: "execute_external_installs", status: "failed" }, { stage: "import_rig", status: "ok" }],
        errors: ["brew install failed"], warnings: [],
      }));
    });
    await new Promise<void>((resolve) => { partialServer.listen(0, resolve); });
    const partialPort = (partialServer.address() as { port: number }).port;

    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(bootstrapCommand(runningDeps(partialPort)));

    const { exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rigged", "bootstrap", "/tmp/rig.yaml", "--yes"]);
    });

    expect(exitCode).toBe(1);
    partialServer.close();
  });

  it("bootstrap --plan invalid response exits 2 and does not print success header", async () => {
    const invalidPlanServer = http.createServer((_, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        runId: "run-bad",
        status: "failed",
        stages: [{ stage: "resolve_spec", status: "failed", detail: { code: "validation_failed", errors: ["bad runtime"] } }],
        errors: ["bad runtime"],
        warnings: [],
      }));
    });
    await new Promise<void>((resolve) => { invalidPlanServer.listen(0, resolve); });
    const invalidPort = (invalidPlanServer.address() as { port: number }).port;

    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(bootstrapCommand(runningDeps(invalidPort)));

    const { logs, exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rigged", "bootstrap", "/tmp/bad.yaml", "--plan"]);
    });

    expect(exitCode).toBe(2);
    expect(logs.some((l) => l.includes("BOOTSTRAP PLAN"))).toBe(false);
    expect(logs.some((l) => l.includes("bad runtime"))).toBe(true);
    invalidPlanServer.close();
  });

  it("bootstrap apply surfaces nested stage-detail errors", async () => {
    const failedApplyServer = http.createServer((_, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        runId: "run-fail",
        status: "failed",
        stages: [
          {
            stage: "import_rig",
            status: "failed",
            detail: { ok: false, code: "preflight_failed", errors: ["Rig name already exists", "tmux session already exists"] },
          },
        ],
        errors: ["Rig import failed: preflight_failed"],
        warnings: [],
      }));
    });
    await new Promise<void>((resolve) => { failedApplyServer.listen(0, resolve); });
    const failedPort = (failedApplyServer.address() as { port: number }).port;

    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(bootstrapCommand(runningDeps(failedPort)));

    const { logs, exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rigged", "bootstrap", "/tmp/rig.yaml", "--yes"]);
    });

    expect(exitCode).toBe(2);
    expect(logs.some((l) => l.includes("Rig name already exists"))).toBe(true);
    expect(logs.some((l) => l.includes("tmux session already exists"))).toBe(true);
    failedApplyServer.close();
  });

  it("bootstrap resolves library name to file path in request body", async () => {
    let capturedSourceRef: string | undefined;
    const libServer = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url ?? "");
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk; });
      req.on("end", () => {
        if (url === "/api/specs/library") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify([{ id: "lib1", name: "my-lib-rig", sourcePath: "/specs/my-lib-rig.yaml", kind: "rig", version: "0.2", sourceType: "user_file" }]));
        } else if (url.includes("/api/bootstrap")) {
          const parsed = JSON.parse(body);
          capturedSourceRef = parsed.sourceRef;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "completed", runId: "run-1", stages: [], errors: [], warnings: [] }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({}));
        }
      });
    });
    await new Promise<void>((resolve) => { libServer.listen(0, resolve); });
    const libPort = (libServer.address() as { port: number }).port;

    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(bootstrapCommand(runningDeps(libPort)));

    await captureLogs(async () => {
      await prog.parseAsync(["node", "rigged", "bootstrap", "my-lib-rig", "--yes"]);
    });

    libServer.close();

    // The resolved sourceRef must be the library file path, not the raw name
    expect(capturedSourceRef).toBe("/specs/my-lib-rig.yaml");
  });
});
