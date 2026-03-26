import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { requirementsCommand } from "../src/commands/requirements.js";
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

describe("Requirements CLI", () => {
  let server: http.Server;
  let port: number;
  let planResponse: Record<string, unknown>;

  beforeAll(async () => {
    planResponse = {
      runId: "run-1", status: "planned",
      stages: [
        { stage: "resolve_spec", status: "ok", detail: {} },
        { stage: "probe_requirements", status: "ok", detail: {
          probed: 2,
          results: [
            { name: "git", kind: "cli_tool", status: "installed", detectedPath: "/usr/bin/git" },
            { name: "missing-tool", kind: "cli_tool", status: "missing", detectedPath: null },
          ],
        }},
        { stage: "build_install_plan", status: "ok", detail: { autoApprovable: 1, manualOnly: 0, alreadyInstalled: 1, actions: [] } },
      ],
      actionKeys: [], errors: [], warnings: [],
    };

    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;

      if (req.url === "/api/bootstrap/plan" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(planResponse));
      } else {
        res.writeHead(500, { "Content-Type": "application/json" });
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
    prog.addCommand(requirementsCommand(runningDeps(port)));
    return prog;
  }

  // T9: requirements prints status table
  it("requirements prints per-requirement status table", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "requirements", "/tmp/rig.yaml"]);
    });
    expect(logs.some((l) => l.includes("REQUIREMENTS"))).toBe(true);
    expect(logs.some((l) => l.includes("OK") && l.includes("git"))).toBe(true);
    expect(logs.some((l) => l.includes("MISSING") && l.includes("missing-tool"))).toBe(true);
  });

  // T10: all requirements met -> exit 0
  it("all requirements met returns exit 0", async () => {
    // Override plan response to have all installed
    const orig = planResponse.stages;
    planResponse.stages = [
      { stage: "probe_requirements", status: "ok", detail: {
        probed: 1,
        results: [{ name: "git", kind: "cli_tool", status: "installed", detectedPath: "/usr/bin/git" }],
      }},
    ];

    const { exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "requirements", "/tmp/rig.yaml"]);
    });
    expect(exitCode).toBeUndefined(); // no exitCode set = 0

    planResponse.stages = orig; // restore
  });

  // T11: some missing -> exit 1
  it("some requirements missing returns exit 1", async () => {
    const { exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "requirements", "/tmp/rig.yaml"]);
    });
    expect(exitCode).toBe(1);
  });

  // T12a: --json with missing requirement -> exit 1
  it("--json with missing requirement returns exit 1", async () => {
    const { exitCode, logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "requirements", "/tmp/rig.yaml", "--json"]);
    });
    expect(exitCode).toBe(1);
    // Should still output JSON
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.requirements).toBeDefined();
  });

  // T12: request body includes sourceRef
  it("request body includes sourceRef from positional arg", async () => {
    let capturedBody = "";
    const origHandler = server.listeners("request")[0] as (...args: unknown[]) => void;
    server.removeAllListeners("request");
    server.on("request", async (req: http.IncomingMessage, res: http.ServerResponse) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      capturedBody = body;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(planResponse));
    });

    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "requirements", "/my/spec.yaml"]);
    });

    const parsed = JSON.parse(capturedBody);
    expect(parsed.sourceRef).toBe("/my/spec.yaml");

    // Restore handler
    server.removeAllListeners("request");
    server.on("request", origHandler);
  });
});
