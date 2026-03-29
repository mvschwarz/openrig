import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { bundleCommand } from "../src/commands/bundle.js";
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

// Captured create bodies for assertion
let capturedCreateBodies: Record<string, unknown>[] = [];

describe("Bundle CLI", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;

      if (req.url === "/api/bundles/create" && req.method === "POST") {
        const parsed = JSON.parse(body || "{}");
        capturedCreateBodies.push(parsed);
        if (String(parsed.specPath ?? "").includes("missing")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing package" }));
          return;
        }
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          bundleName: parsed.bundleName ?? "test",
          bundleVersion: parsed.bundleVersion ?? "0.1.0",
          archiveHash: "abc123",
          packages: 1,
        }));
      } else if (req.url === "/api/bundles/inspect" && req.method === "POST") {
        const parsed = JSON.parse(body || "{}");
        if (String(parsed.bundlePath ?? "").includes("bad")) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Inspect failed" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ manifest: { name: "test", version: "0.1.0" }, digestValid: true, integrityResult: { passed: true } }));
      } else if (req.url === "/api/bundles/install" && req.method === "POST") {
        const parsed = JSON.parse(body);
        if (String(parsed.bundlePath ?? "").includes("blocked")) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "blocked" }));
          return;
        }
        if (parsed.plan) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "planned", runId: "run-1", stages: [] }));
        } else {
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "completed", runId: "run-2", rigId: "rig-1" }));
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
    prog.addCommand(bundleCommand(runningDeps(port)));
    return prog;
  }

  // T11: create produces output
  it("bundle create prints confirmation", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "bundle", "create", "/tmp/rig.yaml", "-o", "/tmp/test.rigbundle"]);
    });
    expect(logs.some((l) => l.includes("Bundle created"))).toBe(true);
    expect(logs.some((l) => l.includes("abc123"))).toBe(true);
  });

  it("bundle create uses --bundle-version without colliding with the CLI version flag", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync([
        "node",
        "rigged",
        "bundle",
        "create",
        "/tmp/rig.yaml",
        "-o",
        "/tmp/test.rigbundle",
        "--bundle-version",
        "2.0.0",
      ]);
    });
    expect(logs.some((l) => l.includes("v2.0.0"))).toBe(true);
  });

  // T12: inspect prints summary
  it("bundle inspect prints summary", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "bundle", "inspect", "/tmp/test.rigbundle"]);
    });
    expect(logs.some((l) => l.includes("Bundle:"))).toBe(true);
    expect(logs.some((l) => l.includes("Integrity: PASS"))).toBe(true);
  });

  // T13: install runs bootstrap
  it("bundle install prints status", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "bundle", "install", "/tmp/test.rigbundle", "--yes", "--target", "/tmp/target"]);
    });
    expect(logs.some((l) => l.includes("completed"))).toBe(true);
    expect(logs.some((l) => l.includes("rig-1"))).toBe(true);
  });

  // T14: --json output
  it("bundle inspect --json outputs parseable JSON", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "bundle", "inspect", "/tmp/test.rigbundle", "--json"]);
    });
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.manifest.name).toBe("test");
  });

  // T15: --plan shows plan
  it("bundle install --plan shows planned status", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "bundle", "install", "/tmp/test.rigbundle", "--plan"]);
    });
    expect(logs.some((l) => l.includes("planned"))).toBe(true);
  });

  it("bundle create --json preserves failure exit code", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "bundle", "create", "/tmp/missing.rig.yaml", "-o", "/tmp/test.rigbundle", "--json"]);
    });
    expect(JSON.parse(logs.join("")).error).toBe("Missing package");
    expect(exitCode).toBe(2);
  });

  it("bundle install --json preserves blocked exit code", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "bundle", "install", "/tmp/blocked.rigbundle", "--json"]);
    });
    expect(JSON.parse(logs.join("")).error).toBe("blocked");
    expect(exitCode).toBe(1);
  });

  // T6: bundle create --rig-root passes rigRoot in request body
  it("bundle create --rig-root passes rigRoot in request body", async () => {
    capturedCreateBodies = [];
    await captureLogs(async () => {
      await makeCmd().parseAsync([
        "node", "rigged", "bundle", "create", "/tmp/rig.yaml",
        "-o", "/tmp/test.rigbundle",
        "--rig-root", "/my/project",
      ]);
    });
    const createBody = capturedCreateBodies[capturedCreateBodies.length - 1];
    expect(createBody).toBeTruthy();
    expect(createBody!["rigRoot"]).toMatch(/\/my\/project/);
  });
});
