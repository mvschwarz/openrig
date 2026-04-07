import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { broadcastCommand } from "../src/commands/broadcast.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(): LifecycleDeps {
  return { spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true), readFile: vi.fn(() => null), writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn(() => false), mkdirp: vi.fn(), openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true) };
}
function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = []; const origLog = console.log; const origErr = console.error; const origExitCode = process.exitCode; process.exitCode = undefined;
    console.log = (...args: unknown[]) => logs.push(args.join(" ")); console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try { await fn(); } finally { console.log = origLog; console.error = origErr; } const exitCode = process.exitCode; process.exitCode = origExitCode; resolve({ logs, exitCode });
  });
}
function runningDeps(port: number): StatusDeps {
  return { lifecycleDeps: { ...mockLifecycleDeps(), exists: vi.fn((p: string) => p === STATE_FILE), readFile: vi.fn((p: string) => { if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-01T00:00:00Z" } as DaemonState); return null; }), fetch: vi.fn(async () => ({ ok: true })) }, clientFactory: (baseUrl) => new DaemonClient(baseUrl) };
}

describe("Broadcast CLI", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk; });
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/api/transport/broadcast") {
          const parsed = JSON.parse(body);
          if (parsed.rig === "empty-rig") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              total: 0, sent: 0, failed: 0,
              results: [
                { ok: false, sessionName: "", error: "No running sessions found for rig 'empty-rig'. Check rig status with: rig ps" },
              ],
            }));
          } else
          if (parsed.rig === "fail-rig") {
            // Partial failure
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              total: 2, sent: 1, failed: 1,
              results: [
                { ok: true, sessionName: "dev-impl@fail-rig" },
                { ok: false, sessionName: "dev-qa@fail-rig", error: "send failed" },
              ],
            }));
          } else {
            // Success (covers both rig-scoped and global)
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              total: 2, sent: 2, failed: 0,
              results: [
                { ok: true, sessionName: "dev-impl@my-rig" },
                { ok: true, sessionName: "dev-qa@my-rig" },
              ],
            }));
          }
        } else { res.writeHead(404).end(); }
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  function makeCmd(): Command {
    const prog = new Command(); prog.exitOverride();
    prog.addCommand(broadcastCommand(runningDeps(port)));
    return prog;
  }

  it("broadcast --rig prints per-target summary", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "broadcast", "--rig", "my-rig", "hello"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("dev-impl@my-rig: sent");
    expect(output).toContain("dev-qa@my-rig: sent");
    expect(output).toContain("2/2 delivered");
  });

  it("broadcast without --rig/--pod sends globally", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "broadcast", "System maintenance"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("2/2 delivered");
  });

  it("broadcast --json prints raw JSON", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "broadcast", "--rig", "my-rig", "hello", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.total).toBe(2);
    expect(parsed.sent).toBe(2);
  });

  it("broadcast exits nonzero when no targets resolve", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "broadcast", "--rig", "empty-rig", "hello"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("No running sessions found");
    expect(output).toContain("0/0 delivered");
    expect(exitCode).toBe(1);
  });
});
