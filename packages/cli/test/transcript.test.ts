import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { transcriptCommand } from "../src/commands/transcript.js";
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
    try { await fn(); } finally { console.log = origLog; console.error = origErr; }
    const exitCode = process.exitCode;
    process.exitCode = origExitCode;
    resolve({ logs, exitCode });
  });
}

function runningDeps(port: number): StatusDeps {
  return {
    lifecycleDeps: {
      ...mockLifecycleDeps(),
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-03-31T00:00:00Z" } as DaemonState);
        return null;
      }),
      fetch: vi.fn(async () => ({ ok: true })),
    },
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
}

describe("Transcript CLI", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url ?? "");
      if (url.startsWith("/api/transcripts/dev.impl@my-rig/tail")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ session: "dev.impl@my-rig", lines: 10, content: "line1\nline2\nline3\n" }));
      } else if (url.startsWith("/api/transcripts/dev.impl@my-rig/grep")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ session: "dev.impl@my-rig", pattern: "decision", matches: ["decision made", "decision final"] }));
      } else if (url.startsWith("/api/transcripts/nonexistent/")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session 'nonexistent' not found. Check session names with: rig ps --nodes" }));
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
    prog.addCommand(transcriptCommand(runningDeps(port)));
    return prog;
  }

  it("--tail prints tail content", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "transcript", "dev.impl@my-rig", "--tail", "10"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("line1");
    expect(output).toContain("line2");
  });

  it("--grep prints matching lines", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "transcript", "dev.impl@my-rig", "--grep", "decision"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("decision made");
    expect(output).toContain("decision final");
  });

  it("--json prints raw JSON", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "transcript", "dev.impl@my-rig", "--tail", "10", "--json"]);
    });
    const output = logs.join("\n");
    const parsed = JSON.parse(output);
    expect(parsed.session).toBe("dev.impl@my-rig");
    expect(parsed.content).toContain("line1");
  });

  it("404 response prints guidance and exits non-zero", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "transcript", "nonexistent", "--tail", "10"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("not found");
    expect(output).toContain("rig ps");
    expect(exitCode).toBe(1);
  });

  it("--tail and --grep together uses grep (precedence)", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "transcript", "dev.impl@my-rig", "--tail", "10", "--grep", "decision"]);
    });
    const output = logs.join("\n");
    // grep mode: should show matched lines, not tail content
    expect(output).toContain("decision made");
  });
});
