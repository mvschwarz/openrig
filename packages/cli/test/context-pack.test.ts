// Rig Context / Composable Context Injection v0 (PL-014) — `rig
// context-pack` CLI verb family tests.
//
// Stands up a small in-memory daemon mock for the /api/context-packs/*
// surface and exercises each subcommand against it.

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { contextPackCommand } from "../src/commands/context-pack.js";
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
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { errLogs.push(args.map(String).join(" ")); };
    process.exitCode = undefined;
    try { await fn(); } catch { /* commander.exitOverride */ }
    const exitCode = process.exitCode;
    console.log = origLog;
    console.error = origErr;
    process.exitCode = origExitCode;
    resolve({ logs, errLogs, exitCode });
  });
}

function runningDeps(port: number): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-05-04T00:00:00Z" } as DaemonState);
        return null;
      }),
      fetch: vi.fn(async () => ({ ok: true })),
    }),
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
}

const FIXTURE_PACK = {
  id: "context-pack:smoke:1",
  kind: "context-pack" as const,
  name: "smoke",
  version: "1",
  purpose: "Smoke test pack",
  sourceType: "user_file" as const,
  sourcePath: "/home/op/.openrig/context-packs/smoke",
  relativePath: "smoke",
  updatedAt: "2026-05-04T00:00:00Z",
  manifestEstimatedTokens: null,
  derivedEstimatedTokens: 100,
  files: [
    { path: "notes.md", role: "notes", summary: "Smoke notes", absolutePath: "/abs/notes.md", bytes: 50, estimatedTokens: 13 },
  ],
};

const FIXTURE_PREVIEW = {
  id: FIXTURE_PACK.id,
  name: FIXTURE_PACK.name,
  version: FIXTURE_PACK.version,
  bundleText: "# OpenRig Context Pack: smoke v1\n\nSmoke test pack\n\n## File: notes.md (role: notes) — Smoke notes\n\nSmoke body\n",
  bundleBytes: 110,
  estimatedTokens: 28,
  files: [{ path: "notes.md", role: "notes", bytes: 50, estimatedTokens: 13 }],
  missingFiles: [] as Array<{ path: string; role: string }>,
};

describe("rig context-pack CLI (PL-014)", () => {
  let server: http.Server;
  let port: number;
  let sendLog: Array<{ id: string; body: unknown }>;
  let sendBehavior: "ok" | "fail" = "ok";

  beforeAll(async () => {
    sendLog = [];
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        const url = req.url ?? "";
        if (url === "/api/context-packs/library" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify([FIXTURE_PACK]));
          return;
        }
        if (url === "/api/context-packs/library/sync" && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ count: 1, errors: [], entries: [FIXTURE_PACK] }));
          return;
        }
        const idMatch = url.match(/^\/api\/context-packs\/library\/([^/]+)(\/(preview|send))?$/);
        if (idMatch) {
          const id = decodeURIComponent(idMatch[1]!);
          const sub = idMatch[3];
          if (id !== FIXTURE_PACK.id) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Context pack '${id}' not found in library` }));
            return;
          }
          if (sub === "preview" && req.method === "GET") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(FIXTURE_PREVIEW));
            return;
          }
          if (sub === "send" && req.method === "POST") {
            const parsed = JSON.parse(body || "{}") as { destinationSession?: string; dryRun?: boolean };
            sendLog.push({ id, body: parsed });
            if (sendBehavior === "fail") {
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Session not found", reason: "session_missing" }));
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              ...FIXTURE_PREVIEW,
              destinationSession: parsed.destinationSession,
              dryRun: !!parsed.dryRun,
              ...(parsed.dryRun ? {} : { sent: true }),
            }));
            return;
          }
          if (!sub && req.method === "GET") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(FIXTURE_PACK));
            return;
          }
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => server.close());

  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(contextPackCommand(runningDeps(port)));
    return prog;
  }

  it("list shows discovered packs", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "context-pack", "list"]);
    });
    expect(exitCode).toBeUndefined();
    expect(logs.join("\n")).toContain("smoke");
    expect(logs.join("\n")).toContain("1 files");
  });

  it("list --json emits JSON", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "context-pack", "list", "--json"]);
    });
    const parsed = JSON.parse(logs.join("")) as Array<{ name: string }>;
    expect(parsed[0]!.name).toBe("smoke");
  });

  it("show resolves by name", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "context-pack", "show", "smoke"]);
    });
    expect(logs.join("\n")).toContain("Name:        smoke");
    expect(logs.join("\n")).toContain("Smoke test pack");
  });

  it("show fails with helpful error on unknown name", async () => {
    const { errLogs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "context-pack", "show", "missing-pack"]);
    });
    expect(exitCode).toBe(1);
    expect(errLogs.join("\n")).toContain("not found in library");
  });

  it("preview prints the assembled bundle text", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "context-pack", "preview", "smoke"]);
    });
    expect(logs.join("\n")).toContain("# OpenRig Context Pack: smoke v1");
    expect(logs.join("\n")).toContain("Smoke body");
  });

  it("send --dry-run does not invoke the daemon send path twice", async () => {
    sendLog.length = 0;
    sendBehavior = "ok";
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "context-pack", "send", "smoke", "driver@rig", "--dry-run"]);
    });
    expect(exitCode).toBeUndefined();
    expect(sendLog).toHaveLength(1);
    expect(sendLog[0]!.body).toEqual({ destinationSession: "driver@rig", dryRun: true });
    expect(logs.join("\n")).toContain("(dry-run)");
  });

  it("send (real) reports successful delivery", async () => {
    sendLog.length = 0;
    sendBehavior = "ok";
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "context-pack", "send", "smoke", "driver@rig"]);
    });
    expect(exitCode).toBeUndefined();
    expect(sendLog[0]!.body).toEqual({ destinationSession: "driver@rig", dryRun: false });
    expect(logs.join("\n")).toContain("Sent smoke v1");
  });

  it("send fails fast when daemon returns 502", async () => {
    sendLog.length = 0;
    sendBehavior = "fail";
    const { errLogs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "context-pack", "send", "smoke", "missing@rig"]);
    });
    expect(exitCode).toBe(1);
    expect(errLogs.join("\n")).toContain("Session not found");
    sendBehavior = "ok";
  });

  it("sync reports indexed count", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "context-pack", "sync"]);
    });
    expect(exitCode).toBeUndefined();
    expect(logs.join("\n")).toContain("Indexed 1 context pack");
  });
});
