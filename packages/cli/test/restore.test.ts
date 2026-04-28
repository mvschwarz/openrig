import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { restoreCommand } from "../src/commands/restore.js";
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
    process.exitCode = undefined;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => errLogs.push(args.join(" "));
    try { await fn(); } finally { console.log = origLog; console.error = origErr; }
    const exitCode = process.exitCode;
    process.exitCode = origExitCode;
    resolve({ logs, errLogs, exitCode });
  });
}

function runningDeps(port: number): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-28T00:00:00Z" } as DaemonState);
        return null;
      }),
      fetch: vi.fn(async () => ({ ok: true })),
    }),
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
}

describe("Restore CLI (L3)", () => {
  let server: http.Server;
  let port: number;
  let lastRoutePath: string | null = null;
  let routeResponse: { status: number; body: unknown } = { status: 202, body: { ok: true, attemptId: 42, status: "started", rigId: "rig-1" } };

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      lastRoutePath = req.url ?? null;
      if (req.url?.startsWith("/api/rigs/") && req.url?.includes("/restore/") && req.method === "POST") {
        res.writeHead(routeResponse.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(routeResponse.body));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(restoreCommand(runningDeps(port)));
    return prog;
  }

  // L3 closeout checklist: CLI prints attempt id from the route's 202 response.
  it("prints 'Restore attempt id: <id>' on stdout (L3 success path)", async () => {
    routeResponse = { status: 202, body: { ok: true, attemptId: 42, status: "started", rigId: "rig-1" } };

    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "restore", "snap-abc", "--rig", "rig-1"]);
    });

    const out = logs.join("\n");
    expect(out).toContain("Restore attempt id: 42");
    expect(out).toContain("Status: started");
    expect(exitCode).toBeUndefined(); // 0
  });

  // L3 closeout checklist: SIGINT message must NOT reference non-existent commands
  // (e.g., a hypothetical `rig events`). It should point at existing surfaces only.
  it("CLI's SIGINT/SIGTERM honest message references only existing surfaces", async () => {
    // Reach into the source to verify the message constant doesn't reference
    // non-existent `rig events`. Inspect the compiled CLI behavior by reading
    // restore.ts directly is heavy; the simpler check is that the bundled
    // command file includes the existing-surface guidance. Use require on the
    // compiled module's signal handler text via a lightweight regex.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const here = path.dirname(new URL(import.meta.url).pathname);
    const restoreSrc = fs.readFileSync(path.resolve(here, "../src/commands/restore.ts"), "utf-8");

    // Must include the honest interrupt message mentioning daemon-side work
    expect(restoreSrc).toMatch(/daemon-side restore may continue/i);
    // Must reference existing surfaces (rig ps --nodes or rig restore-check)
    expect(restoreSrc).toMatch(/rig ps --nodes|rig restore-check/);
    // Must NOT reference a fake `rig events` command (Decision 1 amendment)
    expect(restoreSrc).not.toMatch(/\brig events\b/);
  });

  it("404 from server prints not-found error and exits 1", async () => {
    routeResponse = { status: 404, body: { error: "Snapshot not found" } };

    const { errLogs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "restore", "missing", "--rig", "rig-1"]);
    });

    expect(errLogs.join("\n")).toMatch(/not found/i);
    expect(exitCode).toBe(1);
  });

  it("409 pre_restore_validation_failed prints blockers and exits 1", async () => {
    routeResponse = {
      status: 409,
      body: {
        code: "pre_restore_validation_failed",
        rigResult: "not_attempted",
        blockers: [
          { code: "required_startup_file_missing", severity: "critical", logicalId: "worker", path: "/tmp/missing.md", message: "missing", remediation: "restore the file" },
        ],
        remediation: ["restore the file"],
      },
    };

    const { errLogs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "restore", "snap-blocked", "--rig", "rig-1"]);
    });

    const errOut = errLogs.join("\n");
    expect(errOut).toMatch(/Restore blocked/i);
    expect(errOut).toMatch(/required_startup_file_missing|restore the file|missing\.md/);
    expect(exitCode).toBe(1);
  });
});
