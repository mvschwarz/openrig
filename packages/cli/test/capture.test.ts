import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { captureCommand } from "../src/commands/capture.js";
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

describe("Capture CLI", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk; });
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/api/transport/capture") {
          const parsed = JSON.parse(body);
          if (parsed.session) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, sessionName: parsed.session, content: "line1\nline2\n", lines: 20 }));
          } else if (parsed.rig) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ results: [
              { ok: true, sessionName: "dev-impl@my-rig", content: "impl output", lines: 20 },
              { ok: true, sessionName: "dev-qa@my-rig", content: "qa output", lines: 20 },
            ]}));
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing target" }));
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
    prog.addCommand(captureCommand(runningDeps(port)));
    return prog;
  }

  it("capture prints pane content", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "capture", "dev-impl@my-rig"]);
    });
    expect(logs.join("\n")).toContain("line1");
  });

  it("capture --rig prints multi-session results with headers", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "capture", "--rig", "my-rig"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("--- dev-impl@my-rig ---");
    expect(output).toContain("impl output");
    expect(output).toContain("--- dev-qa@my-rig ---");
  });

  it("capture --json prints raw JSON", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rigged", "capture", "dev-impl@my-rig", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.content).toContain("line1");
  });
});
