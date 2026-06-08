// OPR.0.3.3.19 - rig archive / unarchive CLI surface.
//
// Covers AC-6 (running-rig --force guard surfaces a 3-part honest error),
// the happy archive/unarchive paths, the --force flag wiring, and JSON output.
// The daemon-layer guard is proven in the daemon suite (rig-archive.test.ts);
// here we prove the CLI faithfully surfaces the route's contract.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { archiveCommand } from "../src/commands/archive.js";
import { unarchiveCommand } from "../src/commands/unarchive.js";
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
    const origWrite = process.stderr.write.bind(process.stderr);
    // archive.ts writes the 3-part error via process.stderr.write
    (process.stderr as { write: unknown }).write = (chunk: string) => { logs.push(String(chunk)); return true; };
    try { await fn(); } finally {
      console.log = origLog;
      console.error = origErr;
      (process.stderr as { write: unknown }).write = origWrite;
    }
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

describe("Archive / Unarchive CLI (OPR.0.3.3.19)", () => {
  let server: http.Server;
  let port: number;
  let lastBody: Record<string, unknown>;
  let archiveResponse: { status: number; body: Record<string, unknown> } | null;
  let unarchiveResponse: { status: number; body: Record<string, unknown> } | null;

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (req.url?.endsWith("/archive") && req.method === "POST") {
        lastBody = body ? JSON.parse(body) : {};
        const r = archiveResponse ?? { status: 200, body: { ok: true, rigId: "rig-1", archived: true } };
        res.writeHead(r.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(r.body));
      } else if (req.url?.endsWith("/unarchive") && req.method === "POST") {
        const r = unarchiveResponse ?? { status: 200, body: { ok: true, rigId: "rig-1", unarchived: true } };
        res.writeHead(r.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(r.body));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  function archiveCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(archiveCommand(runningDeps(port)));
    return prog;
  }
  function unarchiveCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(unarchiveCommand(runningDeps(port)));
    return prog;
  }

  it("archive success prints reversible note and exits 0", async () => {
    archiveResponse = { status: 200, body: { ok: true, rigId: "rig-1", archived: true } };
    const { logs, exitCode } = await captureLogs(async () => {
      await archiveCmd().parseAsync(["node", "rig", "archive", "rig-1"]);
    });
    const out = logs.join("\n");
    expect(out).toContain("archived");
    expect(out).toContain("rig unarchive rig-1");
    expect(exitCode).toBeUndefined(); // 0
  });

  it("archive defaults force:false; --force sends force:true", async () => {
    archiveResponse = { status: 200, body: { ok: true, rigId: "rig-1", archived: true } };
    await captureLogs(async () => {
      await archiveCmd().parseAsync(["node", "rig", "archive", "rig-1"]);
    });
    expect(lastBody["force"]).toBe(false);
    await captureLogs(async () => {
      await archiveCmd().parseAsync(["node", "rig", "archive", "rig-1", "--force"]);
    });
    expect(lastBody["force"]).toBe(true);
  });

  it("AC-6: running-rig 409 surfaces the 3-part honest error and exits 2", async () => {
    archiveResponse = {
      status: 409,
      body: { error: {
        fact: "Rig 'alpha' is running (it has live sessions).",
        consequence: "Archiving it would hide a rig with running seats from the default view.",
        action: "Stop it first ('rig down rig-1'), or re-run with --force to archive anyway.",
      } },
    };
    const { logs, exitCode } = await captureLogs(async () => {
      await archiveCmd().parseAsync(["node", "rig", "archive", "rig-1"]);
    });
    const out = logs.join("\n");
    expect(out).toContain("is running");
    expect(out).toContain("would hide a rig with running seats");
    expect(out).toContain("--force to archive anyway");
    expect(exitCode).toBe(2);
  });

  it("archive 404 exits 1 with a list hint", async () => {
    archiveResponse = { status: 404, body: { error: "rig not found" } };
    const { logs, exitCode } = await captureLogs(async () => {
      await archiveCmd().parseAsync(["node", "rig", "archive", "missing"]);
    });
    expect(logs.join("\n")).toContain("Rig not found: missing");
    expect(exitCode).toBe(1);
  });

  it("archive --json emits raw JSON; 409 json exits 2", async () => {
    archiveResponse = { status: 200, body: { ok: true, rigId: "rig-1", archived: true } };
    const { logs } = await captureLogs(async () => {
      await archiveCmd().parseAsync(["node", "rig", "archive", "rig-1", "--json"]);
    });
    expect(JSON.parse(logs.join("")).archived).toBe(true);

    archiveResponse = { status: 409, body: { error: { fact: "f", consequence: "c", action: "a" } } };
    const { exitCode } = await captureLogs(async () => {
      await archiveCmd().parseAsync(["node", "rig", "archive", "rig-1", "--json"]);
    });
    expect(exitCode).toBe(2);
  });

  it("archive already-archived prints already-archived and exits 0", async () => {
    archiveResponse = { status: 200, body: { ok: true, rigId: "rig-1", archived: false } };
    const { logs, exitCode } = await captureLogs(async () => {
      await archiveCmd().parseAsync(["node", "rig", "archive", "rig-1"]);
    });
    expect(logs.join("\n")).toContain("already archived");
    expect(exitCode).toBeUndefined();
  });

  it("unarchive success prints back-in-view and exits 0", async () => {
    unarchiveResponse = { status: 200, body: { ok: true, rigId: "rig-1", unarchived: true } };
    const { logs, exitCode } = await captureLogs(async () => {
      await unarchiveCmd().parseAsync(["node", "rig", "unarchive", "rig-1"]);
    });
    expect(logs.join("\n")).toContain("back in the default view");
    expect(exitCode).toBeUndefined();
  });

  it("unarchive when not archived prints was-not-archived", async () => {
    unarchiveResponse = { status: 200, body: { ok: true, rigId: "rig-1", unarchived: false } };
    const { logs } = await captureLogs(async () => {
      await unarchiveCmd().parseAsync(["node", "rig", "unarchive", "rig-1"]);
    });
    expect(logs.join("\n")).toContain("was not archived");
  });

  it("unarchive 404 exits 1", async () => {
    unarchiveResponse = { status: 404, body: { error: "rig not found" } };
    const { exitCode } = await captureLogs(async () => {
      await unarchiveCmd().parseAsync(["node", "rig", "unarchive", "missing"]);
    });
    expect(exitCode).toBe(1);
  });
});
