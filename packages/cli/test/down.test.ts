import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { downCommand } from "../src/commands/down.js";
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

describe("Down CLI", () => {
  let server: http.Server;
  let port: number;
  let lastBody: Record<string, unknown>;
  let responseOverride: { status: number; body: Record<string, unknown> } | null;

  beforeAll(async () => {
    responseOverride = null;
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;

      if (req.url === "/api/down" && req.method === "POST") {
        lastBody = JSON.parse(body);

        if (responseOverride) {
          res.writeHead(responseOverride.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(responseOverride.body));
          return;
        }

        const rigId = lastBody["rigId"] as string;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          rigId, sessionsKilled: 2, snapshotId: null,
          deleted: false, deleteBlocked: false, alreadyStopped: false, errors: [],
        }));
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
    prog.addCommand(downCommand(runningDeps(port)));
    return prog;
  }

  // T1: down success -> exit 0
  it("down success prints summary and exits 0", async () => {
    responseOverride = null;
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "rig-1"]);
    });
    expect(logs.some((l) => l.includes("stopped"))).toBe(true);
    expect(logs.some((l) => l.includes("2 session(s) killed"))).toBe(true);
    expect(exitCode).toBeUndefined(); // 0
  });

  // T2a: down alreadyStopped (no delete) -> exit 1
  it("down alreadyStopped with no delete exits 1", async () => {
    responseOverride = {
      status: 200,
      body: { rigId: "rig-1", sessionsKilled: 0, snapshotId: null, deleted: false, deleteBlocked: false, alreadyStopped: true, errors: [] },
    };
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "rig-1"]);
    });
    expect(logs.some((l) => l.includes("already stopped"))).toBe(true);
    expect(exitCode).toBe(1);
  });

  // T2b: down alreadyStopped + deleted -> exit 0 (deletion succeeded)
  it("down alreadyStopped with successful delete exits 0", async () => {
    responseOverride = {
      status: 200,
      body: { rigId: "rig-1", sessionsKilled: 0, snapshotId: null, deleted: true, deleteBlocked: false, alreadyStopped: true, errors: [] },
    };
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "rig-1"]);
    });
    expect(logs.some((l) => l.includes("deleted"))).toBe(true);
    expect(exitCode).toBeUndefined(); // 0
  });

  // T2c: deleted + snapshot error -> exit 2
  it("down deleted with snapshot errors exits 2", async () => {
    responseOverride = {
      status: 200,
      body: { rigId: "rig-1", sessionsKilled: 2, snapshotId: null, deleted: true, deleteBlocked: false, alreadyStopped: false, errors: ["Snapshot failed: disk full"] },
    };
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "rig-1"]);
    });
    expect(logs.some((l) => l.includes("warning"))).toBe(true);
    expect(exitCode).toBe(2);
  });

  // T3: down with errors, deleted=false -> exit 2
  it("down with errors and no delete exits 2", async () => {
    responseOverride = {
      status: 200,
      body: { rigId: "rig-1", sessionsKilled: 1, snapshotId: null, deleted: false, deleteBlocked: true, alreadyStopped: false, errors: ["Kill failed for session 'r01-x': timeout"] },
    };
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "rig-1"]);
    });
    expect(exitCode).toBe(2);
  });

  // T4: down --delete sends delete:true
  it("down --delete sends delete flag", async () => {
    responseOverride = {
      status: 200,
      body: { rigId: "rig-1", sessionsKilled: 2, snapshotId: null, deleted: true, deleteBlocked: false, alreadyStopped: false, errors: [] },
    };
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "rig-1", "--delete"]);
    });
    expect(lastBody["delete"]).toBe(true);
  });

  // T5: down --snapshot sends snapshot:true
  it("down --snapshot sends snapshot flag", async () => {
    responseOverride = null;
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "rig-1", "--snapshot"]);
    });
    expect(lastBody["snapshot"]).toBe(true);
  });

  // T6: down --force sends force:true
  it("down --force sends force flag", async () => {
    responseOverride = null;
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "rig-1", "--force"]);
    });
    expect(lastBody["force"]).toBe(true);
  });

  // T7: down --json raw output
  it("down --json outputs raw JSON", async () => {
    responseOverride = null;
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "rig-1", "--json"]);
    });
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.rigId).toBe("rig-1");
    expect(parsed.sessionsKilled).toBe(2);
  });

  // T8: down 404 -> exit 2
  it("down with 404 exits 2", async () => {
    responseOverride = { status: 404, body: { error: "Rig not found: missing" } };
    const { exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "missing"]);
    });
    expect(exitCode).toBe(2);
  });

  // T9: --json + alreadyStopped -> exit 1
  it("down --json with alreadyStopped exits 1", async () => {
    responseOverride = {
      status: 200,
      body: { rigId: "rig-1", sessionsKilled: 0, snapshotId: null, deleted: false, deleteBlocked: false, alreadyStopped: true, errors: [] },
    };
    const { exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "rig-1", "--json"]);
    });
    expect(exitCode).toBe(1);
  });

  // T10: --json + 200 + errors -> exit 2
  it("down --json with errors exits 2", async () => {
    responseOverride = {
      status: 200,
      body: { rigId: "rig-1", sessionsKilled: 2, snapshotId: null, deleted: true, deleteBlocked: false, alreadyStopped: false, errors: ["Snapshot failed: disk full"] },
    };
    const { exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "down", "rig-1", "--json"]);
    });
    expect(exitCode).toBe(2);
  });
});
